import { cpus } from 'node:os';
import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getList, getNumber } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import { loadConfig } from '../core/config.ts';
import { CliError, EXIT, UsageError } from '../core/errors.ts';
import { findTool, isHardware } from '../core/ffmpeg.ts';
import { DEFAULT_PART_BYTES, guessMedia, hashFile, MIB, planParts } from '../core/hash.ts';
import { Semaphore } from '../core/limit.ts';
import { normalizeTags } from '../core/parse.ts';
import { probeFile, probeTools } from '../core/probe.ts';
import {
  clearJournal,
  decideUpload,
  hashCacheKey,
  type Journal,
  loadHashCache,
  pruneJournals,
  readJournal,
  saveHashCache,
  writeJournal,
} from '../core/resume.ts';
import {
  chooseEncoder,
  clearTranscodeArtifacts,
  decideView,
  deriveStateFor,
  encodeProxy,
  extractPoster,
  photoNeedsView,
  planIsEmpty,
  planWork,
  probeVideo,
  remuxProxy,
  renderPhotoView,
  type VideoStreamInfo,
  type WorkPlan,
} from '../core/transcode.ts';
import type { Asset, BeginBody, UploadedPart, UploadRole } from '../core/types.ts';
import { mapPool, type WalkedFile, walkPaths } from '../core/walk.ts';
import { cyan, dim, yellow } from '../ui/color.ts';
import { countAndSize, formatBytes, formatDuration, formatRate, plural } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { Progress } from '../ui/progress.ts';

export const uploadFlags: FlagSpecs = {
  tag: { type: 'list', short: 't', describe: 'Tag every uploaded asset (repeatable)' },
  concurrency: { type: 'number', short: 'c', describe: 'Parallel transfers (default 4)' },
  jobs: { type: 'number', short: 'j', describe: 'Parallel video encodes (default cores-2)' },
  'part-size': { type: 'number', describe: 'Multipart part size in MB (default 64)' },
  all: { type: 'boolean', describe: 'Include files whose extension is not a known media type' },
  probe: { type: 'boolean', describe: 'Read metadata with ffprobe/exiftool (default on)' },
  transcode: { type: 'boolean', describe: 'Encode video proxies locally (default on)' },
  'dry-run': { type: 'boolean', describe: 'Hash, probe and report; encode and upload nothing' },
  json: { type: 'boolean', describe: 'Emit a machine-readable summary' },
};

interface Candidate extends WalkedFile {
  sha256: string;
  mime: string;
  kind: 'photo' | 'video';
}

/**
 * What the local-processing phase produced for one asset.
 *
 * Keys are not built here: a derivative names its parent and its role, and the
 * worker decides where the bytes land. That is what makes it impossible for the
 * CLI to accidentally write a proxy to a standalone asset key.
 */
interface Derived {
  /** What still has to be produced and sent for this file. */
  plan: WorkPlan;
  /** The view was produced by a stream copy rather than a re-encode. */
  remuxed?: boolean;
  /** The 1080p H.264 proxy, or the bounded JPEG for an oversize photo. */
  viewPath: string | null;
  viewMime: string;
  /** Video poster frame. Photos never get one — thumb/ is video-only. */
  posterPath: string | null;
  /** The original is already browser-safe; no view derivative is uploaded. */
  viewIsOriginal: boolean;
  /** An oversize photo ffmpeg could not decode: original only, no view. */
  undecodable: boolean;
  reason: string;
}

interface Outcome {
  path: string;
  filename: string;
  sha256: string;
  assetId: string | null;
  bytes: number;
  kind: 'photo' | 'video';
  status: 'uploaded' | 'skipped' | 'failed';
  stage?: 'transcode' | 'upload';
  deriveState?: 'ready' | 'skipped' | 'pending';
  /** An oversize photo that could not be rendered; uploaded without a view. */
  noView?: boolean;
  error?: string;
}

export async function upload(args: ParsedArgs): Promise<number> {
  if (args.positionals.length === 0) throw new UsageError('Nothing to upload — give paths.');

  const tags = normalizeTags(getList(args, 'tag'));
  const concurrency = clampConcurrency(getNumber(args, 'concurrency', 4));
  const jobs = clampJobs(getNumber(args, 'jobs', defaultJobs()));
  const partSize = Math.max(5, getNumber(args, 'part-size', DEFAULT_PART_BYTES / MIB)) * MIB;
  const dryRun = getBool(args, 'dry-run');
  const transcodeEnabled = getBool(args, 'transcode', true);
  const json = getBool(args, 'json');
  out.setJsonMode(json);

  const files = await walkPaths(args.positionals, { all: getBool(args, 'all') });
  if (files.length === 0) {
    out.note('No media files found in those paths.');
    return 0;
  }

  await pruneJournals();
  const candidates = await hashAll(files, concurrency, json);

  // Content addressing means the same bytes twice in one run is one upload.
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.sha256)) unique.set(candidate.sha256, candidate);
  }
  const duplicatesInBatch = candidates.length - unique.size;
  const work = [...unique.values()];
  const videos = work.filter((candidate) => candidate.kind === 'video');

  if (dryRun) return await reportDryRun(work, videos, duplicatesInBatch, tags, json);

  const client = new ApiClient(await loadConfig());
  const probeEnabled = getBool(args, 'probe', true);
  await warnAboutMissingProbes(probeEnabled, work, json);

  // Ask once what the pool already holds, rows and all. A derivative cannot
  // short-circuit server-side — its hash is never persisted, so `begin` always
  // reports exists:false for one — so the decision to skip an encode has to be
  // made here, against the parent row's derivative keys.
  const pool = await client
    .listAllAssets({})
    .then((assets) => new Map(assets.map((asset) => [asset.id, asset])))
    .catch(() => new Map<string, Asset>());

  // ---------------------------------------------------- local processing ----
  const derived = new Map<string, Derived>();
  const transcodeFailures: Outcome[] = [];

  const needsWork: Candidate[] = [];
  // Files that need no bytes sent still need to appear in the outcomes: a
  // re-run whose whole purpose is `--tag` must still tag them.
  const settledOutcomes: Outcome[] = [];
  for (const candidate of work) {
    // Videos are re-planned after probing, once it is known whether the
    // original is browser-safe; this pass only settles the unambiguous cases.
    const plan = planWork({
      kind: candidate.kind,
      bytes: candidate.bytes,
      existing: pool.get(candidate.sha256) ?? null,
      transcode: transcodeEnabled,
    });
    if (planIsEmpty(plan)) {
      settledOutcomes.push({
        path: candidate.path,
        filename: candidate.name,
        sha256: candidate.sha256,
        // The asset id IS the sha256 of the original, so no call is needed.
        assetId: candidate.sha256,
        bytes: candidate.bytes,
        kind: candidate.kind,
        status: 'skipped',
      });
    } else {
      needsWork.push(candidate);
    }
  }

  const settled = settledOutcomes.length;
  if (settled > 0 && !json) {
    out.note(
      `${settled} of ${work.length} already complete in the pool — nothing to encode or send for ${
        settled === 1 ? 'it' : 'them'
      }.`,
    );
  }

  const pendingVideos = needsWork.filter((candidate) => candidate.kind === 'video');
  const pendingPhotos = needsWork.filter(
    (candidate) => candidate.kind === 'photo' && photoNeedsView(candidate.bytes),
  );

  if ((pendingVideos.length > 0 && transcodeEnabled) || pendingPhotos.length > 0) {
    await announceEncoder(json);
    await processLocally(
      transcodeEnabled ? pendingVideos : [],
      pendingPhotos,
      pool,
      transcodeEnabled,
      jobs,
      json,
      derived,
      transcodeFailures,
    );
  }
  if (pendingVideos.length > 0 && !transcodeEnabled && !json) {
    out.warn(
      `--no-transcode: ${pendingVideos.length} video(s) upload without a browser-playable proxy.`,
    );
  }

  // ---------------------------------------------------------------- upload --
  const uploadable = needsWork.filter(
    (candidate) => !transcodeFailures.some((failure) => failure.sha256 === candidate.sha256),
  );
  const totalBytes = uploadable.reduce((sum, file) => sum + file.bytes, 0);
  const progress = new Progress({
    verb: 'Uploading',
    totalFiles: uploadable.length,
    totalBytes,
    tty: json ? false : undefined,
  });
  const gate = new Semaphore(concurrency);

  const outcomes: Outcome[] = [...transcodeFailures, ...settledOutcomes];
  try {
    await mapPool(uploadable, concurrency, async (candidate) => {
      outcomes.push(
        await uploadOne({
          candidate,
          derived: derived.get(candidate.sha256) ?? null,
          client,
          gate,
          partSize,
          progress,
          probeEnabled,
        }),
      );
    });
  } finally {
    progress.stop();
  }

  const uploaded = outcomes.filter((outcome) => outcome.status === 'uploaded');
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');

  const tagged = await applyTags(client, tags, [...uploaded, ...skipped], json);
  const summary = progress.summary();

  if (json) {
    out.json({
      uploaded: uploaded.length,
      skipped: skipped.length,
      failed: failed.length,
      duplicatesInBatch,
      transcoded: [...derived.values()].filter((d) => d.viewPath !== null && d.remuxed !== true)
        .length,
      remuxed: [...derived.values()].filter((d) => d.remuxed === true).length,
      reusedOriginal: [...derived.values()].filter((d) => d.viewIsOriginal).length,
      photosWithoutView: outcomes.filter((outcome) => outcome.noView === true).length,
      tagged,
      tags,
      bytes: uploaded.reduce((sum, outcome) => sum + outcome.bytes, 0),
      seconds: Number(summary.seconds.toFixed(2)),
      assets: outcomes,
    });
    return failed.length > 0 ? EXIT.api : 0;
  }

  reportSummary({ uploaded, skipped, failed, duplicatesInBatch, derived, tags, tagged, summary });
  return failed.length > 0 ? EXIT.api : 0;
}

// ----------------------------------------------------------------- phases ---

/**
 * Hashing is its own pass so the progress bar has a real denominator before a
 * single byte goes over the wire. Digests are cached by path+size+mtime, which
 * is what makes re-running an interrupted upload of a 300 GB library cheap.
 */
async function hashAll(
  files: readonly WalkedFile[],
  concurrency: number,
  json: boolean,
): Promise<Candidate[]> {
  const cache = await loadHashCache();
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const progress = new Progress({
    verb: 'Hashing',
    totalFiles: files.length,
    totalBytes,
    tty: json ? false : undefined,
  });

  const candidates: Candidate[] = [];
  try {
    await mapPool(files, Math.min(concurrency, 8), async (file) => {
      const key = hashCacheKey(file.path, file.bytes, file.mtimeMs);
      const cached = cache.get(key);
      progress.start(file.path, file.name, file.bytes);

      let sha256 = cached;
      if (sha256 === undefined) {
        const result = await hashFile(file.path, (bytes) => progress.advance(file.path, bytes));
        sha256 = result.sha256;
        cache.set(key, sha256);
      } else {
        progress.advance(file.path, file.bytes);
      }

      const guess = guessMedia(file.name) ?? {
        kind: 'photo' as const,
        mime: 'application/octet-stream',
      };
      candidates.push({ ...file, sha256, mime: guess.mime, kind: guess.kind });
      progress.finish(
        file.path,
        'verified',
        file.name,
        cached === undefined ? undefined : 'cached',
      );
    });
  } finally {
    progress.stop();
  }

  await saveHashCache(cache);
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Everything that happens on this machine before a byte goes over the wire:
 * video proxies, video poster frames, and bounded view renditions for photos
 * the edge cannot transform.
 *
 * Failure here is granular by construction. One clip ffmpeg cannot read is
 * recorded and the batch carries on — aborting an overnight import of four
 * hundred videos because clip 212 has a broken index would be indefensible.
 */
async function processLocally(
  videos: readonly Candidate[],
  oversizePhotos: readonly Candidate[],
  pool: ReadonlyMap<string, Asset>,
  transcode: boolean,
  jobs: number,
  json: boolean,
  derived: Map<string, Derived>,
  failures: Outcome[],
): Promise<void> {
  const work = [...videos, ...oversizePhotos];
  if (work.length === 0) return;

  const progress = new Progress({
    verb: 'Encoding',
    totalFiles: work.length,
    // Progress is counted in percent-of-file, not bytes: an encode's position
    // is a timestamp, and source size predicts nothing about how long it takes.
    totalBytes: work.length * 100,
    tty: json ? false : undefined,
  });

  try {
    await mapPool(work, jobs, async (candidate) => {
      progress.start(candidate.sha256, candidate.name, 100);
      try {
        const existing = pool.get(candidate.sha256) ?? null;
        if (candidate.kind === 'photo') {
          await derivePhoto(candidate, existing, derived, progress);
        } else {
          await deriveVideo(candidate, existing, transcode, derived, progress);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.finish(candidate.sha256, 'failed', candidate.name, message);
        failures.push({
          path: candidate.path,
          filename: candidate.name,
          sha256: candidate.sha256,
          assetId: null,
          bytes: candidate.bytes,
          kind: candidate.kind,
          status: 'failed',
          stage: 'transcode',
          error: message,
        });
      }
    });
  } finally {
    progress.stop();
  }
}

async function deriveVideo(
  candidate: Candidate,
  existing: Asset | null,
  transcode: boolean,
  derived: Map<string, Derived>,
  progress: Progress,
): Promise<void> {
  const info: VideoStreamInfo | null = await probeVideo(candidate.path);
  if (info === null) throw new CliError('ffprobe could not read the file.');

  const decision = decideView(info);
  const viewIsOriginal = decision.action === 'reuse-original';
  // Now that the source is understood, plan properly: an asset whose row
  // already carries both keys needs neither an encode nor an upload.
  const plan = planWork({
    kind: 'video',
    bytes: candidate.bytes,
    existing,
    viewIsOriginal,
    transcode,
  });

  const poster = plan.needsThumb
    ? await extractPoster(candidate.path, candidate.sha256, info.duration)
    : null;

  if (viewIsOriginal || !plan.needsView) {
    derived.set(candidate.sha256, {
      plan,
      viewPath: null,
      viewMime: 'video/mp4',
      posterPath: poster,
      viewIsOriginal,
      undecodable: false,
      reason: viewIsOriginal ? decision.reason : 'proxy already in the pool',
    });
    progress.advance(candidate.sha256, 100);
    progress.finish(
      candidate.sha256,
      'skipped',
      candidate.name,
      viewIsOriginal ? decision.reason : 'proxy already in the pool',
    );
    return;
  }

  // A remux is attempted first when the picture is already right, and falls
  // back to a real encode if the bitstream cannot be copied into MP4.
  let result =
    decision.action === 'remux' ? await remuxProxy(candidate.path, candidate.sha256, info) : null;
  const remuxFailed = decision.action === 'remux' && result === null;

  if (result === null) {
    let last = 0;
    result = await encodeProxy(candidate.path, candidate.sha256, info, (fraction) => {
      const next = Math.round(fraction * 100);
      if (next > last) {
        progress.advance(candidate.sha256, next - last);
        last = next;
      }
    });
    if (last < 100) progress.advance(candidate.sha256, 100 - last);
  } else {
    progress.advance(candidate.sha256, 100);
  }

  derived.set(candidate.sha256, {
    plan,
    remuxed: result.remuxed,
    viewPath: result.path,
    viewMime: 'video/mp4',
    posterPath: poster,
    viewIsOriginal: false,
    undecodable: false,
    reason: decision.reason,
  });
  progress.finish(
    candidate.sha256,
    'uploaded',
    candidate.name,
    `${result.remuxed ? 'remux' : 'encode'} ${result.width}×${result.height} ${formatBytes(result.bytes)}${
      result.seconds > 0 ? ` in ${formatDuration(result.seconds)}` : ' (cached)'
    }${remuxFailed ? ' (stream copy refused, re-encoded)' : ''}`,
  );
}

/**
 * A photo above the Images 20 MB input cap gets a bounded JPEG so the share
 * page has something to show. If ffmpeg cannot decode it — ProRAW DNG is the
 * realistic case — that is recorded rather than thrown: the original still
 * uploads, the asset simply has no view, and the edge answers 415 with a
 * placeholder rather than handing over the full-resolution file.
 */
async function derivePhoto(
  candidate: Candidate,
  existing: Asset | null,
  derived: Map<string, Derived>,
  progress: Progress,
): Promise<void> {
  const plan = planWork({ kind: 'photo', bytes: candidate.bytes, existing, transcode: true });
  const rendered = plan.needsView ? await renderPhotoView(candidate.path, candidate.sha256) : null;
  progress.advance(candidate.sha256, 100);

  derived.set(candidate.sha256, {
    plan,
    viewPath: rendered,
    viewMime: 'image/jpeg',
    posterPath: null,
    viewIsOriginal: false,
    undecodable: plan.needsView && rendered === null,
    reason: rendered === null ? 'ffmpeg could not decode it' : 'above the 20 MB Images cap',
  });

  if (!plan.needsView) {
    progress.finish(candidate.sha256, 'skipped', candidate.name, 'view already in the pool');
    return;
  }
  if (rendered === null) {
    progress.finish(
      candidate.sha256,
      'skipped',
      candidate.name,
      'cannot decode locally; original only, no view',
    );
    return;
  }
  const bytes = (await Bun.file(rendered).stat()).size;
  progress.finish(candidate.sha256, 'uploaded', candidate.name, `view ${formatBytes(bytes)}`);
}

interface UploadOneInput {
  candidate: Candidate;
  derived: Derived | null;
  client: ApiClient;
  gate: Semaphore;
  partSize: number;
  progress: Progress;
  probeEnabled: boolean;
}

/**
 * Uploads one asset and any derivatives it has.
 *
 * The original goes first, always. A derivative names its parent by sha256, and
 * the contract rejects one whose parent has no row with a 409 rather than
 * orphaning the bytes — so the order here is not a preference, it is the only
 * sequence that works.
 */
async function uploadOne(input: UploadOneInput): Promise<Outcome> {
  const { candidate, derived, client, gate, partSize, progress, probeEnabled } = input;
  const base: Omit<Outcome, 'status' | 'assetId'> = {
    path: candidate.path,
    filename: candidate.name,
    sha256: candidate.sha256,
    bytes: candidate.bytes,
    kind: candidate.kind,
  };
  const deriveState = deriveStateFor({
    kind: candidate.kind,
    viewIsOriginal: derived?.viewIsOriginal === true,
    hasProxy: derived?.viewPath !== null && derived !== null,
  });
  const noView = derived?.undecodable === true;

  try {
    progress.start(candidate.path, candidate.name, candidate.bytes);

    const body: BeginBody = {
      sha256: candidate.sha256,
      filename: candidate.name,
      bytes: candidate.bytes,
      mime: candidate.mime,
      kind: candidate.kind,
      role: 'orig',
    };
    // Tells the worker no proxy is coming, so it can settle derive_state now
    // rather than leaving the video 'pending' indefinitely.
    if (derived?.viewIsOriginal === true) body.viewIsOriginal = true;
    if (probeEnabled) Object.assign(body, await probeFile(candidate.path, candidate.kind));

    const begin = await gate.run(() => client.beginUpload(body));
    const alreadyThere = begin.exists === true;

    if (alreadyThere) {
      progress.advance(candidate.path, candidate.bytes);
    } else {
      if (begin.uploadId === undefined) {
        throw new CliError('upload/begin returned no uploadId for a new asset.', {
          code: EXIT.api,
          hint: 'Uploads are always multipart; check the deployed worker version.',
        });
      }
      const parts = await sendParts({
        client,
        gate,
        candidate,
        assetId: begin.assetId,
        uploadId: begin.uploadId,
        partSize,
        progress,
      });
      await gate.run(() => client.completeUpload({ uploadId: begin.uploadId as string, parts }));
      await clearJournal(candidate.sha256);
    }

    // The row that `begin` handed back is more current than the pool snapshot
    // taken before the encode, so a derivative already present is not re-sent.
    const row = begin.asset ?? null;
    const wantView =
      derived !== null &&
      derived.viewPath !== null &&
      !hasKey(row?.view_key) &&
      derived.plan.needsView;
    const wantThumb =
      derived !== null &&
      derived.posterPath !== null &&
      !hasKey(row?.thumb_key) &&
      derived.plan.needsThumb;

    if (alreadyThere && !wantView && !wantThumb) {
      progress.finish(candidate.path, 'skipped', candidate.name, 'already in pool');
      await clearTranscodeArtifacts(candidate.sha256);
      return { ...base, assetId: begin.assetId, status: 'skipped', deriveState };
    }

    // Only now that the parent row exists can its derivatives be accepted.
    let derivativeBytes = 0;
    if (wantView && derived !== null && derived.viewPath !== null) {
      derivativeBytes += await uploadDerivative({
        client,
        gate,
        partSize,
        path: derived.viewPath,
        role: 'view',
        ofAsset: candidate.sha256,
        mime: derived.viewMime,
      });
    }
    if (wantThumb && derived !== null && derived.posterPath !== null) {
      derivativeBytes += await uploadDerivative({
        client,
        gate,
        partSize,
        path: derived.posterPath,
        role: 'thumb',
        ofAsset: candidate.sha256,
        mime: 'image/jpeg',
      });
    }
    await clearTranscodeArtifacts(candidate.sha256);

    // When the original was already there, only the derivatives crossed the
    // wire — reporting the original's size would overstate what was sent.
    const moved = alreadyThere ? derivativeBytes : candidate.bytes + derivativeBytes;
    progress.finish(
      candidate.path,
      'uploaded',
      candidate.name,
      alreadyThere ? `derivatives only, ${formatBytes(moved)}` : formatBytes(candidate.bytes),
    );
    return {
      ...base,
      bytes: moved,
      assetId: begin.assetId,
      status: 'uploaded',
      deriveState,
      noView,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.finish(candidate.path, 'failed', candidate.name, message);
    return { ...base, assetId: null, status: 'failed', stage: 'upload', error: message };
  }
}

function hasKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value !== '';
}

function sortParts(parts: readonly UploadedPart[]): UploadedPart[] {
  return [...parts].sort((a, b) => a.partNumber - b.partNumber);
}

/**
 * Sends a file's parts, skipping any the worker already holds.
 *
 * Resume is now a property of the system rather than of one laptop: the
 * contracted `/upload/:uploadId/parts` is consulted first, and the local
 * journal is only a fallback for a worker that has not been redeployed.
 */
interface SendPartsInput {
  client: ApiClient;
  gate: Semaphore;
  candidate: Candidate;
  assetId: string;
  uploadId: string;
  partSize: number;
  progress: Progress;
}

async function sendParts(input: SendPartsInput): Promise<UploadedPart[]> {
  const { client, gate, candidate, assetId, uploadId, partSize, progress } = input;
  const path = candidate.path;
  const plan = planParts(candidate.bytes, partSize);

  const remote = await client
    .listUploadParts(uploadId)
    .then((response) =>
      (response.parts ?? []).map((part) => ({ partNumber: part.part, etag: part.etag })),
    )
    .catch(() => null);

  const journal = await readJournal(candidate.sha256);
  const decision = decideUpload({
    remoteExists: false,
    uploadId,
    journal:
      remote !== null && remote.length > 0
        ? {
            sha256: candidate.sha256,
            path,
            bytes: candidate.bytes,
            mtimeMs: candidate.mtimeMs,
            assetId,
            uploadId,
            partSize: plan.partSize,
            parts: remote,
            updatedAt: Date.now(),
          }
        : journal,
    plan,
    sha256: candidate.sha256,
    bytes: candidate.bytes,
    mtimeMs: candidate.mtimeMs,
  });

  const done: UploadedPart[] = decision.action === 'resume' ? [...decision.done] : [];
  const todo =
    decision.action === 'resume'
      ? plan.parts.filter((part) => decision.remaining.includes(part.partNumber))
      : plan.parts;

  if (decision.action === 'resume' && done.length > 0) {
    const already = done.reduce(
      (sum, part) =>
        sum +
        (plan.parts.find((entry) => entry.partNumber === part.partNumber)?.end ?? 0) -
        (plan.parts.find((entry) => entry.partNumber === part.partNumber)?.start ?? 0),
      0,
    );
    progress.advance(path, already);
    progress.log(
      dim(
        `  resuming ${candidate.name} — ${done.length}/${plan.parts.length} parts already sent${
          remote !== null && remote.length > 0 ? ' (worker-side)' : ''
        }`,
      ),
    );
  }

  const record: Journal = {
    sha256: candidate.sha256,
    path,
    bytes: candidate.bytes,
    mtimeMs: candidate.mtimeMs,
    assetId,
    uploadId,
    partSize: plan.partSize,
    parts: done,
    updatedAt: Date.now(),
  };

  await mapPool(todo, Math.max(1, Math.min(4, todo.length)), async (part) => {
    const slice = Bun.file(path).slice(part.start, part.end);
    const { etag } = await gate.run(() => client.uploadPart(uploadId, part.partNumber, slice));
    done.push({ partNumber: part.partNumber, etag });
    record.parts = sortParts(done);
    // Journalled per part, so an interrupt costs one part rather than the file.
    await writeJournal(record);
    progress.advance(path, part.end - part.start);
  });

  return sortParts(done);
}

interface DerivativeInput {
  client: ApiClient;
  gate: Semaphore;
  partSize: number;
  path: string;
  role: Exclude<UploadRole, 'orig'>;
  /** The ORIGINAL's sha256. The derivative is named after its parent. */
  ofAsset: string;
  mime: string;
}

/**
 * Uploads a locally produced derivative — a video proxy, a poster frame, or a
 * bounded view for an oversize photo.
 *
 * The sha256 sent here is the derivative's own hash, used purely so the worker
 * can verify the bytes arrived intact; it never appears in a key. The key comes
 * from `role` and `ofAsset`, which is what makes it impossible for a proxy to
 * become a standalone asset by accident.
 */
async function uploadDerivative(input: DerivativeInput): Promise<number> {
  const { client, gate, partSize, path, role, ofAsset, mime } = input;
  const { sha256, bytes } = await hashFile(path);

  const begin = await gate.run(() =>
    client.beginUpload({
      sha256,
      filename: `${ofAsset}.${role}`,
      bytes,
      mime,
      role,
      ofAsset,
    }),
  );
  if (begin.exists === true) return 0;
  if (begin.uploadId === undefined) {
    throw new CliError(`upload/begin returned no uploadId for the ${role} of ${ofAsset}.`, {
      code: EXIT.api,
    });
  }
  const uploadId = begin.uploadId;

  const plan = planParts(bytes, partSize);
  const parts: UploadedPart[] = [];
  await mapPool(plan.parts, Math.max(1, Math.min(4, plan.parts.length)), async (part) => {
    const slice = Bun.file(path).slice(part.start, part.end);
    const { etag } = await gate.run(() => client.uploadPart(uploadId, part.partNumber, slice));
    parts.push({ partNumber: part.partNumber, etag });
  });

  await gate.run(() => client.completeUpload({ uploadId, parts: sortParts(parts) }));
  return bytes;
}

// ------------------------------------------------------------- reporting ----

interface SummaryInput {
  uploaded: Outcome[];
  skipped: Outcome[];
  failed: Outcome[];
  duplicatesInBatch: number;
  derived: Map<string, Derived>;
  tags: readonly string[];
  tagged: number;
  summary: { seconds: number; rate: number };
}

function reportSummary(input: SummaryInput): void {
  const { uploaded, skipped, failed, duplicatesInBatch, derived, tags, tagged, summary } = input;
  const movedBytes = uploaded.reduce((sum, outcome) => sum + outcome.bytes, 0);

  out.line();
  if (uploaded.length > 0) {
    out.ok(
      `${countAndSize(uploaded.length, movedBytes)} in ${formatDuration(summary.seconds)} ${dim(
        `(${formatRate(summary.rate)})`,
      )}`,
    );
  }
  const values = [...derived.values()];
  const remuxed = values.filter((d) => d.remuxed === true).length;
  const encoded = values.filter(
    (d) => d.viewPath !== null && d.viewMime === 'video/mp4' && d.remuxed !== true,
  ).length;
  const reused = values.filter((d) => d.viewIsOriginal).length;
  const photoViews = values.filter(
    (d) => d.viewPath !== null && d.viewMime === 'image/jpeg',
  ).length;
  if (encoded > 0) out.line(dim(`${encoded} video ${plural(encoded, 'proxy', 'proxies')} encoded`));
  if (remuxed > 0) {
    out.line(
      dim(
        `${remuxed} video ${plural(remuxed, 'proxy', 'proxies')} remuxed (stream copy, no re-encode)`,
      ),
    );
  }
  if (reused > 0) {
    out.line(dim(`${reused} video(s) already browser-safe, uploaded without a proxy`));
  }
  if (photoViews > 0) {
    out.line(
      dim(`${photoViews} oversize ${plural(photoViews, 'photo')} given a bounded view rendition`),
    );
  }
  if (skipped.length > 0) out.line(dim(`${skipped.length} already in pool, skipped`));
  if (duplicatesInBatch > 0) {
    out.line(
      dim(`${duplicatesInBatch} duplicate ${plural(duplicatesInBatch, 'path')} in this batch`),
    );
  }
  if (tags.length > 0) {
    out.line(dim(`tagged ${tagged} ${plural(tagged, 'asset')} ${cyan(tags.join(' '))}`));
  }

  const withoutView = uploaded.filter((outcome) => outcome.noView === true);
  if (withoutView.length > 0) {
    out.line();
    out.warn(
      `${withoutView.length} oversize ${plural(withoutView.length, 'photo')} could not be decoded locally and ${
        withoutView.length === 1 ? 'has' : 'have'
      } no view rendition:`,
    );
    for (const outcome of withoutView) out.hint(`  ${outcome.filename}`);
    out.hint('The originals uploaded and are downloadable; the share page shows a placeholder');
    out.hint('rather than serving the full-resolution file. Install a decoder ffmpeg can use,');
    out.hint('or convert them to JPEG/TIFF and re-upload.');
  }

  if (failed.length === 0) {
    if (uploaded.length === 0 && skipped.length > 0) out.note('Nothing new to upload.');
    return;
  }

  out.line();
  const encodeFailures = failed.filter((outcome) => outcome.stage === 'transcode');
  for (const failure of failed) {
    out.fail(
      `${failure.stage === 'transcode' ? 'encode' : 'upload'} — ${failure.filename}: ${
        failure.error ?? 'unknown error'
      }`,
    );
  }
  out.line();
  if (encodeFailures.length > 0) {
    out.hint('Retry just the files that failed to encode:');
    out.hint(`  ms upload ${encodeFailures.map((f) => shellQuote(f.path)).join(' ')}`);
    out.hint('Or upload them without a proxy: add --no-transcode.');
  } else {
    out.hint('Re-run the same command; completed files and parts are skipped.');
  }
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

async function announceEncoder(json: boolean): Promise<void> {
  if (json) return;
  const encoder = await chooseEncoder();
  const ffmpeg = await findTool('ffmpeg');
  const where =
    ffmpeg?.source === 'bundled'
      ? 'bundled'
      : ffmpeg?.source === 'override'
        ? 'MS_FFMPEG_PATH'
        : 'system PATH';
  out.note(
    `Encoding with ${encoder}${isHardware(encoder) ? ' (hardware)' : ''}, ffmpeg from ${where}.`,
  );
}

async function applyTags(
  client: ApiClient,
  tags: readonly string[],
  outcomes: readonly Outcome[],
  json: boolean,
): Promise<number> {
  if (tags.length === 0) return 0;
  const ids = outcomes
    .map((outcome) => outcome.assetId)
    .filter((id): id is string => id !== null && id !== '');
  if (ids.length === 0) return 0;

  // Chunked: a thousand-photo import must not become one enormous request body.
  let updated = 0;
  for (let index = 0; index < ids.length; index += 200) {
    const batch = ids.slice(index, index + 200);
    try {
      const result = await client.tagAssets(batch, [...tags], []);
      updated += result.updated ?? batch.length;
    } catch (error) {
      if (!json) out.warn(`Tagging failed for ${batch.length} assets: ${describe(error)}`);
    }
  }
  return updated;
}

async function warnAboutMissingProbes(
  enabled: boolean,
  work: readonly Candidate[],
  json: boolean,
): Promise<void> {
  if (!enabled || json) return;
  const tools = await probeTools();
  if (!tools.exiftool && work.some((candidate) => candidate.kind === 'photo')) {
    out.note(
      'exiftool not found — photo EXIF dates fall back to file mtime. It is not bundled (it is a Perl distribution); ffmpeg is.',
    );
  }
}

async function reportDryRun(
  work: readonly Candidate[],
  videos: readonly Candidate[],
  duplicates: number,
  tags: readonly string[],
  json: boolean,
): Promise<number> {
  const bytes = work.reduce((sum, file) => sum + file.bytes, 0);

  const plans: { filename: string; action: string; reason: string }[] = [];
  for (const video of videos) {
    const info = await probeVideo(video.path).catch(() => null);
    if (info === null) {
      plans.push({ filename: video.name, action: 'unreadable', reason: 'ffprobe failed' });
      continue;
    }
    const decision = decideView(info);
    plans.push({ filename: video.name, action: decision.action, reason: decision.reason });
  }

  if (json) {
    out.json({
      dryRun: true,
      files: work.length,
      bytes,
      duplicatesInBatch: duplicates,
      tags,
      videos: plans,
      assets: work.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    });
    return 0;
  }

  out.line();
  out.note(`Would upload ${countAndSize(work.length, bytes)}.`);
  if (duplicates > 0) {
    out.note(`${duplicates} duplicate ${plural(duplicates, 'path')} collapsed by hash.`);
  }
  for (const plan of plans) {
    const label =
      plan.action === 'encode'
        ? cyan('encode')
        : plan.action === 'remux'
          ? cyan('remux ')
          : plan.action === 'unreadable'
            ? yellow('skip  ')
            : dim('reuse ');
    out.line(`  ${label}  ${plan.filename}  ${dim(plan.reason)}`);
  }
  if (tags.length > 0) out.note(`Would tag them ${tags.join(' ')}.`);
  out.note('Files already in the pool are only detectable once upload/begin is called.');
  return 0;
}

// ------------------------------------------------------------------ misc ----

/**
 * Leave the machine usable. Encoding saturates every core it is given, and a
 * laptop that stops responding for an hour is a worse experience than an import
 * that takes ten minutes longer.
 */
export function defaultJobs(cores: number = cpus().length): number {
  return Math.max(1, cores - 2);
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1)
    throw new UsageError('--concurrency must be at least 1.');
  return Math.min(32, Math.floor(value));
}

function clampJobs(value: number): number {
  if (!Number.isFinite(value) || value < 1) throw new UsageError('--jobs must be at least 1.');
  return Math.min(32, Math.floor(value));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
