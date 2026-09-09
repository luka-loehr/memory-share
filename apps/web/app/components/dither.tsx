'use client';

import { useEffect, useRef, useState } from 'react';

/*
 * The gate's backdrop: the memory's cover, dissolved.
 *
 * Two things happen at once here, and they are the same thing. Aesthetically it
 * is a plate under safelight, breathing — an image caught halfway out of the
 * developer. Practically it is the privacy boundary: the source served to this
 * component is already a 64px blurred frame (the server degrades it; see the
 * cover route), and the shader then quantises what is left to four levels
 * through an 8x8 Bayer matrix at a third of device resolution. Nothing legible
 * survives that, and nothing legible was ever sent.
 */

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;

varying vec2 v_uv;

uniform sampler2D u_cover;
uniform sampler2D u_bayer;
uniform vec2  u_resolution;
uniform vec2  u_cover_scale;  // cover-fit correction
uniform float u_time;
uniform float u_ready;        // 0 until the cover has decoded

const vec3 INK  = vec3(0.039, 0.035, 0.031);
const vec3 WARM = vec3(0.898, 0.533, 0.235);
const vec3 SILV = vec3(0.925, 0.898, 0.855);

void main() {
  vec2 uv = (v_uv - 0.5) * u_cover_scale + 0.5;

  // The breath: a slow standing wave across the plate, plus a wash drifting
  // through it. Low frequency on purpose — this should read as liquid, not as
  // a screensaver.
  float breath = sin(u_time * 0.28) * 0.5 + 0.5;
  uv += vec2(
    sin(uv.y * 3.1 + u_time * 0.21) * 0.012,
    cos(uv.x * 2.7 - u_time * 0.17) * 0.012
  ) * (0.55 + 0.45 * breath);

  vec3 sampled = texture2D(u_cover, clamp(uv, 0.0, 1.0)).rgb;
  float lum = dot(sampled, vec3(0.299, 0.587, 0.114));

  // Lift and stretch: the blurred source is flat, so pull contrast back into it
  // before quantising or every pixel lands on the same level.
  lum = clamp((lum - 0.5) * 1.65 + 0.5, 0.0, 1.0);

  // A band of "developer" sweeping the plate, brightening what it crosses.
  float wash = smoothstep(0.42, 0.0, abs(fract(u_time * 0.045) * 2.4 - 1.2 - (uv.x + uv.y) * 0.4));
  lum = clamp(lum + wash * 0.16 + (breath - 0.5) * 0.05, 0.0, 1.0);

  // Ordered dither. The Bayer value is the per-pixel threshold offset; four
  // levels keeps recognisable structure from reassembling itself.
  float threshold = texture2D(u_bayer, gl_FragCoord.xy / 8.0).r;
  float levels = 4.0;
  float q = floor(lum * levels + threshold) / levels;
  q = clamp(q, 0.0, 1.0);

  // Duotone: ink through safelight amber to a bare hint of silver at the top.
  vec3 color = mix(INK, WARM, smoothstep(0.0, 0.72, q));
  color = mix(color, SILV, smoothstep(0.78, 1.0, q) * 0.55);

  // Vignette, so the auth panel always has quiet ground beneath it.
  vec2 d = (v_uv - 0.5) * vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  color *= 1.0 - smoothstep(0.35, 1.05, length(d)) * 0.55;

  // Before the cover decodes, show the same field driven by the wash alone
  // rather than a flash of black.
  color = mix(INK * (0.6 + wash * 0.8), color, u_ready);

  gl_FragColor = vec4(color, 1.0);
}`;

/** The canonical 8x8 ordered-dither matrix, as a texture of thresholds. */
function bayerTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const matrix = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) data[i] = Math.round(((matrix[i] + 0.5) / 64) * 255);

  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 8, 8, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
  // NEAREST + REPEAT is what makes it a threshold matrix rather than a blur.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return texture;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export type DitherProps = {
  /** Usually /api/m/:slug/cover — already degraded server-side. */
  src: string;
  className?: string;
};

export function Dither({ src, className }: DitherProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl =
      (canvas.getContext('webgl', { antialias: false, alpha: false }) as WebGLRenderingContext) ??
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) {
      setFailed(true);
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !program) {
      setFailed(true);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailed(true);
      return;
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: a WebGL call, not a React hook.
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attrib = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(attrib);
    gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      cover: gl.getUniformLocation(program, 'u_cover'),
      bayer: gl.getUniformLocation(program, 'u_bayer'),
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      coverScale: gl.getUniformLocation(program, 'u_cover_scale'),
      time: gl.getUniformLocation(program, 'u_time'),
      ready: gl.getUniformLocation(program, 'u_ready'),
    };

    const bayer = bayerTexture(gl);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bayer);
    gl.uniform1i(uniforms.bayer, 1);

    // A single dark texel stands in until the cover decodes.
    const cover = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cover);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([10, 9, 8, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniforms.cover, 0);

    let ready = 0;
    let aspect = 1;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      aspect = image.naturalWidth / Math.max(image.naturalHeight, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cover);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      ready = 1;
    };
    // A cover that will not load is not an error worth surfacing; the wash
    // field alone is a perfectly good gate.
    image.onerror = () => {};
    image.src = src;

    // A third of device resolution: the dither dots have to be big enough to
    // see, and this is also why the whole thing costs almost nothing to run.
    const SCALE = 3;
    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round((rect.width * dpr) / SCALE));
      const h = Math.max(1, Math.round((rect.height * dpr) / SCALE));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    const draw = (t: number) => {
      resize();
      gl.uniform2f(uniforms.resolution, width, height);
      gl.uniform1f(uniforms.ready, ready);

      // Cover-fit: shrink the axis that has slack so the frame is never squashed.
      const viewAspect = width / Math.max(height, 1);
      const scale = viewAspect > aspect ? [1, aspect / viewAspect] : [viewAspect / aspect, 1];
      gl.uniform2f(uniforms.coverScale, scale[0], scale[1]);

      gl.uniform1f(uniforms.time, t / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let frame = 0;
    const loop = (t: number) => {
      draw(t);
      frame = requestAnimationFrame(loop);
    };

    if (reduced.matches) {
      // Still rendered, just not animated — a fixed moment of the same plate.
      draw(0);
      const once = () => draw(0);
      image.addEventListener('load', once);
      window.addEventListener('resize', once);
      return () => {
        image.removeEventListener('load', once);
        window.removeEventListener('resize', once);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      };
    }

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [src]);

  if (failed) {
    // No WebGL. The source is already unreadable, and this stacks a halftone
    // dot mask and a duotone over it so the fallback belongs to the same design
    // rather than looking like a broken version of it.
    return (
      <div className={className} aria-hidden="true">
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${src})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: 'blur(14px) contrast(1.7) saturate(0.5) sepia(0.6) brightness(0.75)',
            transform: 'scale(1.15)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'radial-gradient(circle at center, rgba(10,9,8,0) 34%, rgba(10,9,8,0.95) 36%)',
            backgroundSize: '6px 6px',
            mixBlendMode: 'multiply',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse at 50% 45%, rgba(210,73,44,0.16), rgba(10,9,8,0.9) 78%)',
          }}
        />
      </div>
    );
  }

  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is not focusable.
  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
