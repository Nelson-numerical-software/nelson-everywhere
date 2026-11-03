var U=Object.defineProperty;var C=(n,e,t)=>e in n?U(n,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):n[e]=t;var c=(n,e,t)=>C(n,typeof e!="symbol"?e+"":e,t);import{a1 as G,a2 as L}from"../app.js";function M(){return globalThis.navigator?.gpu??null}const x=`
struct Uniforms {
  model: mat4x4<f32>,
  projection: mat4x4<f32>,
  lineColor: vec4<f32>,
  viewportLine: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
`,I=`${x}
@vertex
fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  var clip = u.projection * u.model * vec4<f32>(position, 1.0);
  clip.z = (clip.z + clip.w) * 0.5;
  return clip;
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}
`,T=`${x}
struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) vertexColor: vec4<f32>) -> VSOut {
  var out: VSOut;
  var clip = u.projection * u.model * vec4<f32>(position, 1.0);
  clip.z = (clip.z + clip.w) * 0.5;
  out.position = clip;
  out.color = vertexColor;
  return out;
}
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
`,_=`${x}
struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) edge: f32,
};
@vertex
fn vs_main(
  @location(0) startPosition: vec3<f32>,
  @location(1) endPosition: vec3<f32>,
  @location(2) corner: vec2<f32>
) -> VSOut {
  let viewportSize = u.viewportLine.xy;
  let lineWidth = u.viewportLine.z;
  let startClip = u.projection * u.model * vec4<f32>(startPosition, 1.0);
  let endClip = u.projection * u.model * vec4<f32>(endPosition, 1.0);
  var clip = select(startClip, endClip, corner.x > 0.5);
  let deltaPixels = (endClip.xy / endClip.w - startClip.xy / startClip.w) * viewportSize * 0.5;
  let lengthPixels = max(length(deltaPixels), 0.0001);
  let normalPixels = vec2<f32>(-deltaPixels.y, deltaPixels.x) / lengthPixels;
  let halfWidth = max(0.25, lineWidth * 0.5);
  let extent = halfWidth + 0.75;
  let offsetXy = clip.xy + normalPixels * corner.y * extent * 2.0 / viewportSize * clip.w;
  var depth = clip.z - 0.00002 * clip.w;
  depth = (depth + clip.w) * 0.5;
  var out: VSOut;
  out.position = vec4<f32>(offsetXy, depth, clip.w);
  out.edge = corner.y;
  return out;
}
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let lineWidth = u.viewportLine.z;
  let halfWidth = max(0.25, lineWidth * 0.5);
  let core = halfWidth / (halfWidth + 0.75);
  let coverage = 1.0 - smoothstep(core, 1.0, abs(in.edge));
  return vec4<f32>(u.lineColor.rgb, u.lineColor.a * coverage);
}
`,P=new Float32Array([0,-1,1,-1,0,1,0,1,1,-1,1,1]),v=256,w=v/4,B={color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}},V=n=>n+3&-4;function b(n){return n instanceof Float32Array?n:new Float32Array(n??[])}class W{constructor(e,t,i,r,s,a,d,h){c(this,"canvas");c(this,"device");c(this,"context");c(this,"bindGroupLayout");c(this,"cornerBuffer");c(this,"depthPipeline");c(this,"fillPipeline");c(this,"linePipeline");c(this,"backend","webgpu");c(this,"meshes",new Map);c(this,"activeMeshIds",new Set);c(this,"depthTexture",null);c(this,"depthWidth",0);c(this,"depthHeight",0);c(this,"uniformBuffer",null);c(this,"uniformBindGroup",null);c(this,"uniformCapacity",0);c(this,"lost",!1);this.canvas=e,this.device=t,this.context=i,this.bindGroupLayout=r,this.cornerBuffer=s,this.depthPipeline=a,this.fillPipeline=d,this.linePipeline=h,this.device.lost.then(p=>{this.lost=!0})}createBuffer(e,t){const i=V(e.byteLength),r=this.device.createBuffer({size:i,usage:t|GPUBufferUsage.COPY_DST});return this.device.queue.writeBuffer(r,0,e),r}ensureDepthTexture(e,t){return(!this.depthTexture||this.depthWidth!==e||this.depthHeight!==t)&&(this.depthTexture?.destroy(),this.depthTexture=this.device.createTexture({size:{width:e,height:t},format:"depth24plus",usage:GPUTextureUsage.RENDER_ATTACHMENT}),this.depthWidth=e,this.depthHeight=t),this.depthTexture.createView()}ensureUniformBuffer(e){const t=Math.max(1,e);this.uniformBuffer&&this.uniformCapacity>=t||(this.uniformBuffer?.destroy(),this.uniformCapacity=t,this.uniformBuffer=this.device.createBuffer({size:t*v,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.uniformBindGroup=this.device.createBindGroup({layout:this.bindGroupLayout,entries:[{binding:0,resource:{buffer:this.uniformBuffer,offset:0,size:v}}]}))}resource(e){const t=this.meshes.get(e.id);if(t?.revision===e.revision)return t;if(t?.vertices.destroy(),t?.colors?.destroy(),t?.triangles?.destroy(),t?.lineEndpoints?.destroy(),!e.positions||!e.triangleIndices||!e.lineIndices)throw new Error("WebGPU mesh geometry unavailable");const i=b(e.positions),r=e.triangleIndices instanceof Uint16Array||e.triangleIndices instanceof Uint32Array?e.triangleIndices:e.triangleIndexType==="uint16"?new Uint16Array(e.triangleIndices):new Uint32Array(e.triangleIndices),s=G(i,e.lineIndices),a={revision:e.revision,vertices:this.createBuffer(i,GPUBufferUsage.VERTEX),triangles:r.length>0?this.createBuffer(r,GPUBufferUsage.INDEX):void 0,lineEndpoints:s.length>0?this.createBuffer(s,GPUBufferUsage.VERTEX):void 0,triangleIndexFormat:r instanceof Uint16Array?"uint16":"uint32",triangleCount:r.length,lineSegmentCount:s.length/6};return e.drawFaces&&e.vertexColors&&(a.colors=this.createBuffer(b(e.vertexColors),GPUBufferUsage.VERTEX)),this.meshes.set(e.id,a),a}writeUniforms(e,t){const i=new Float32Array(Math.max(1,e.length)*w);for(let r=0;r<e.length;r++){const s=e[r],a=r*w;i.set(s.model,a),i.set(s.projection,a+16),i.set(s.lineColor,a+32),i[a+36]=s.viewport[2]*t,i[a+37]=s.viewport[3]*t,i[a+38]=s.lineWidth*t}return i}meshViewport(e,t,i){const[r,s,a,d]=e.viewport,h=Math.max(1,Math.round(a*i)),p=Math.max(1,Math.round(d*i)),g=Math.max(0,t-Math.round((s+d)*i));return[Math.round(r*i),g,h,p]}render(e,t,i,r){if(this.lost)throw new Error("WebGPU device lost");const s=Math.max(1,Math.round(t*r)),a=Math.max(1,Math.round(i*r));this.canvas.width!==s&&(this.canvas.width=s),this.canvas.height!==a&&(this.canvas.height=a),this.activeMeshIds.clear();const d=e.map(o=>(this.activeMeshIds.add(o.id),this.resource(o)));for(const[o,f]of this.meshes)this.activeMeshIds.has(o)||(f.vertices.destroy(),f.colors?.destroy(),f.triangles?.destroy(),f.lineEndpoints?.destroy(),this.meshes.delete(o));this.ensureUniformBuffer(e.length);const h=this.uniformBuffer,p=this.uniformBindGroup;if(!h||!p)throw new Error("WebGPU uniforms unavailable");this.device.queue.writeBuffer(h,0,this.writeUniforms(e,r));const g=this.ensureDepthTexture(s,a),y=this.device.createCommandEncoder(),u=y.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:"clear",storeOp:"store"}],depthStencilAttachment:{view:g,depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"store"}}),m=o=>{const[f,l,S,E]=this.meshViewport(o,a,r);u.setViewport(f,l,S,E,0,1)};if(L(e)){u.setPipeline(this.depthPipeline);for(let o=0;o<e.length;o++){const f=e[o],l=d[o];f.drawFaces||!l.triangles||l.triangleCount===0||(m(f),u.setBindGroup(0,p,[o*v]),u.setVertexBuffer(0,l.vertices),u.setIndexBuffer(l.triangles,l.triangleIndexFormat),u.drawIndexed(l.triangleCount))}}u.setPipeline(this.fillPipeline);for(let o=0;o<e.length;o++){const f=e[o],l=d[o];!f.drawFaces||!l.triangles||!l.colors||(m(f),u.setBindGroup(0,p,[o*v]),u.setVertexBuffer(0,l.vertices),u.setVertexBuffer(1,l.colors),u.setIndexBuffer(l.triangles,l.triangleIndexFormat),u.drawIndexed(l.triangleCount))}u.setPipeline(this.linePipeline);for(let o=0;o<e.length;o++){const f=e[o],l=d[o];!l.lineEndpoints||l.lineSegmentCount===0||(m(f),u.setBindGroup(0,p,[o*v]),u.setVertexBuffer(0,l.lineEndpoints),u.setVertexBuffer(1,this.cornerBuffer),u.draw(6,l.lineSegmentCount))}u.end(),this.device.queue.submit([y.finish()])}destroy(){for(const e of this.meshes.values())e.vertices.destroy(),e.colors?.destroy(),e.triangles?.destroy(),e.lineEndpoints?.destroy();this.meshes.clear(),this.activeMeshIds.clear(),this.cornerBuffer.destroy(),this.uniformBuffer?.destroy(),this.depthTexture?.destroy(),this.uniformBuffer=null,this.uniformBindGroup=null,this.depthTexture=null,this.lost||this.device.destroy()}}function O(n,e){const t=n.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform",hasDynamicOffset:!0,minBindingSize:v}}]}),i=n.createPipelineLayout({bindGroupLayouts:[t]}),r={arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:"float32x3"}]},s={arrayStride:16,attributes:[{shaderLocation:1,offset:0,format:"float32x4"}]},a={arrayStride:24,stepMode:"instance",attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"}]},d={arrayStride:8,attributes:[{shaderLocation:2,offset:0,format:"float32x2"}]},h=n.createShaderModule({code:I}),p=n.createShaderModule({code:T}),g=n.createShaderModule({code:_}),y=n.createRenderPipeline({layout:i,vertex:{module:h,entryPoint:"vs_main",buffers:[r]},fragment:{module:h,entryPoint:"fs_main",targets:[{format:e,writeMask:0}]},primitive:{topology:"triangle-list"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less-equal",depthBias:1,depthBiasSlopeScale:1}}),u=n.createRenderPipeline({layout:i,vertex:{module:p,entryPoint:"vs_main",buffers:[r,s]},fragment:{module:p,entryPoint:"fs_main",targets:[{format:e,blend:B}]},primitive:{topology:"triangle-list"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less-equal"}}),m=n.createRenderPipeline({layout:i,vertex:{module:g,entryPoint:"vs_main",buffers:[a,d]},fragment:{module:g,entryPoint:"fs_main",targets:[{format:e,blend:B}]},primitive:{topology:"triangle-list"},depthStencil:{format:"depth24plus",depthWriteEnabled:!1,depthCompare:"less-equal"}});return{bindGroupLayout:t,depthPipeline:y,fillPipeline:u,linePipeline:m}}async function A(n){const e=M();if(!e)return null;try{const t=await e.requestAdapter({powerPreference:"high-performance"});if(!t)return null;const i=await t.requestDevice(),r=n.getContext("webgpu");if(!r)return i.destroy(),null;const s=e.getPreferredCanvasFormat();r.configure({device:i,format:s,alphaMode:"premultiplied"});const{bindGroupLayout:a,depthPipeline:d,fillPipeline:h,linePipeline:p}=O(i,s),g=i.createBuffer({size:P.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});return i.queue.writeBuffer(g,0,P),new W(n,i,r,a,g,d,h,p)}catch{return null}}export{A as tryCreateWebGpuRenderer};
