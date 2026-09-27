// Import generated atlas cells; keep the original RGBA art inside each connected sprite.
// Run from repository root: node tools/import_monk_actions.cjs <generated-atlas.png>
const sharp=require('sharp');
if(!process.argv[2])throw Error('Pass the generated transparent 3 x 5 atlas PNG');
(async()=>{const {data,info}=await sharp(process.argv[2]).ensureAlpha().raw().toBuffer({resolveWithObject:true});const {width:w,height:h}=info,seen=new Uint8Array(w*h),components=[];
for(let p=0;p<w*h;p++){if(seen[p]||data[p*4+3]<20)continue;seen[p]=1;const stack=[p],pixels=[];let left=w,top=h,right=0,bottom=0;
while(stack.length){const q=stack.pop(),x=q%w,y=Math.floor(q/w);pixels.push(q);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);for(const [nx,ny]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){if(nx<0||nx>=w||ny<0||ny>=h)continue;const n=ny*w+nx;if(!seen[n]&&data[n*4+3]>=20){seen[n]=1;stack.push(n);}}}
if(pixels.length>1000)components.push({left,top,right,bottom,pixels});}
if(components.length!==15)throw Error('Expected exactly 15 sprites');
components.sort((a,b)=>a.top-b.top);
for(let row=0;row<5;row++){const layers=[],cells=components.slice(row*3,row*3+3).sort((a,b)=>a.left-b.left);for(let col=0;col<3;col++){const c=cells[col],cw=c.right-c.left+1,ch=c.bottom-c.top+1;const cell=Buffer.alloc(cw*ch*4);for(const q of c.pixels){const x=q%w-c.left,y=Math.floor(q/w)-c.top;data.copy(cell,(y*cw+x)*4,q*4,q*4+4);}
const resized=await sharp(cell,{raw:{width:cw,height:ch,channels:4}}).resize({height:332,kernel:'nearest'}).png().toBuffer({resolveWithObject:true});layers.push({input:resized.data,left:col*320+Math.round((320-resized.info.width)/2),top:28});}
await sharp({create:{width:960,height:384,channels:4,background:'#00000000'}}).composite(layers).webp({lossless:true}).toFile('sprites/monk-actions/lv'+[1,10,20,30,40][row]+'.webp');}
})();
