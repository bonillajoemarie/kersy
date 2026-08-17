import type { Camera, DrawEdge, DrawNode, Renderer } from "./renderer";

const NODE_VS = `#version 300 es
layout(location=0) in vec2 aPos;      // unit quad corner (-1..1)
layout(location=1) in vec3 aInst;     // x, y, radius (world)
layout(location=2) in vec4 aColor;    // rgb + pulse
uniform vec2 uView;                   // viewport px
uniform vec3 uCam;                    // camX, camY, zoom
out vec2 vLocal; out vec4 vColor;
void main() {
  float r = aInst.z * (1.0 + 0.25 * aColor.a);          // pulse grows radius
  vec2 world = aInst.xy + aPos * r;
  vec2 screen = (world - uCam.xy) * uCam.z;
  gl_Position = vec4(screen / (uView * 0.5) * vec2(1,-1), 0.0, 1.0);
  vLocal = aPos; vColor = aColor;
}`;
const NODE_FS = `#version 300 es
precision mediump float;
in vec2 vLocal; in vec4 vColor; out vec4 frag;
void main() {
  float d = length(vLocal);
  float alpha = 1.0 - smoothstep(0.92, 1.0, d);          // antialiased disc
  if (alpha <= 0.0) discard;
  float rim = smoothstep(0.82, 0.87, d) * (1.0 - smoothstep(0.87, 0.92, d));
  vec3 color = mix(vColor.rgb, vColor.rgb * 0.65, rim);   // ~35% darken in rim zone
  frag = vec4(color, alpha);
}`;
const EDGE_VS = `#version 300 es
layout(location=0) in vec2 aPos;      // world endpoint
uniform vec2 uView; uniform vec3 uCam;
void main() {
  vec2 screen = (aPos - uCam.xy) * uCam.z;
  gl_Position = vec4(screen / (uView * 0.5) * vec2(1,-1), 0.0, 1.0);
}`;
const EDGE_FS = `#version 300 es
precision mediump float; out vec4 frag;
void main() { frag = vec4(0.290, 0.302, 0.306, 0.7); }   // #4a4d4e @ 70%`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (t: number, src: string) => {
    const s = gl.createShader(t)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}

export class GlRenderer implements Renderer {
  private nodeProg: WebGLProgram; private edgeProg: WebGLProgram;
  private quad: WebGLBuffer; private inst: WebGLBuffer; private colors: WebGLBuffer; private edgeBuf: WebGLBuffer;
  private vaoNodes: WebGLVertexArrayObject; private vaoEdges: WebGLVertexArrayObject;

  constructor(private gl: WebGL2RenderingContext) {
    this.nodeProg = compile(gl, NODE_VS, NODE_FS);
    this.edgeProg = compile(gl, EDGE_VS, EDGE_FS);
    this.quad = gl.createBuffer()!; this.inst = gl.createBuffer()!;
    this.colors = gl.createBuffer()!; this.edgeBuf = gl.createBuffer()!;
    this.vaoNodes = gl.createVertexArray()!; this.vaoEdges = gl.createVertexArray()!;

    gl.bindVertexArray(this.vaoNodes);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(this.vaoEdges);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.169, 0.169, 0.169, 1);   // Darcula bg #2B2B2B
  }

  resize(w: number, h: number): void {
    this.gl.canvas.width = w; this.gl.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  draw(nodes: DrawNode[], edges: DrawEdge[], cam: Camera): void {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    const view: [number, number] = [gl.canvas.width, gl.canvas.height];

    gl.useProgram(this.edgeProg);
    gl.uniform2fv(gl.getUniformLocation(this.edgeProg, "uView"), view);
    gl.uniform3f(gl.getUniformLocation(this.edgeProg, "uCam"), cam.x, cam.y, cam.zoom);
    const edata = new Float32Array(edges.length * 4);
    edges.forEach((e, i) => edata.set([e.x1, e.y1, e.x2, e.y2], i * 4));
    gl.bindVertexArray(this.vaoEdges);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, edata, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, edges.length * 2);

    gl.useProgram(this.nodeProg);
    gl.uniform2fv(gl.getUniformLocation(this.nodeProg, "uView"), view);
    gl.uniform3f(gl.getUniformLocation(this.nodeProg, "uCam"), cam.x, cam.y, cam.zoom);
    const idata = new Float32Array(nodes.length * 3);
    const cdata = new Float32Array(nodes.length * 4);
    nodes.forEach((n, i) => { idata.set([n.x, n.y, n.radius], i * 3); cdata.set([...n.color, n.pulse], i * 4); });
    gl.bindVertexArray(this.vaoNodes);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, idata, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
    gl.bufferData(gl.ARRAY_BUFFER, cdata, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodes.length);
    gl.bindVertexArray(null);
  }
}
