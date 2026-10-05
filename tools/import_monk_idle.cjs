// Package image-generated breathing artwork; no procedural pose generation.
// node tools/import_monk_idle.cjs <2-column/4-row Lv1..30 PNG> <2-column Lv40 PNG>
const sharp=require('sharp');
const fs=require('node:fs');
async function sprites(file,count){
  const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const w=info.width,h=info.height,seen=new Uint8Array(w*h),out=[];
  for(let p=0;p<w*h;p++){
    if(seen[p]||data[p*4+3]<20)continue;
    seen[p]=1;const stack=[p],pixels=[];let left=w,top=h,right=0,bottom=0;
    while(stack.length){
      const q=stack.pop(),x=q%w,y=Math.floor(q/w);pixels.push(q);
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(const [nx,ny]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){
        if(nx<0||nx>=w||ny<0||ny>=h)continue;
        const n=ny*w+nx;if(!seen[n]&&data[n*4+3]>=20){seen[n]=1;stack.push(n);}
      }
    }
    if(pixels.length>1000)out.push({left,top,right,bottom,pixels});
  }
  if(out.length!==count)throw Error(`Expected ${count} sprites in ${file}, got ${out.length}`);
  out.sort((a,b)=>a.top-b.top);
  return {data,w,out};
}
(async()=>{
  if(process.argv.length!==4)throw Error('Pass the Lv1–30 atlas and the Lv40 sheet');
  fs.mkdirSync('sprites/monk-idle',{recursive:true});
  const sources=[await sprites(process.argv[2],8),await sprites(process.argv[3],2)];
  for(const [i,tier]of [1,10,20,30,40].entries()){
    const {data,w,out}=sources[i===4?1:0];
    const cells=out.slice(i===4?0:i*2,i===4?2:i*2+2).sort((a,b)=>a.left-b.left);
    // Both drawings receive the SAME uniform scale. Align their feet, not their arm silhouettes.
    const scale=332/Math.max(...cells.map(c=>c.bottom-c.top+1)),layers=[];
    for(const [col,c]of cells.entries()){
      const cw=c.right-c.left+1,ch=c.bottom-c.top+1,raw=Buffer.alloc(cw*ch*4);
      let footLeft=w,footRight=0;
      for(const q of c.pixels){
        const x=q%w,y=Math.floor(q/w);
        data.copy(raw,((y-c.top)*cw+x-c.left)*4,q*4,q*4+4);
        if(y>=c.bottom-ch*.1){footLeft=Math.min(footLeft,x);footRight=Math.max(footRight,x);}
      }
      const height=Math.round(ch*scale),width=Math.round(cw*scale);
      const input=await sharp(raw,{raw:{width:cw,height:ch,channels:4}})
        .resize(width,height,{kernel:'nearest'}).png().toBuffer();
      const footCenter=((footLeft+footRight)/2-c.left)*scale;
      const left=col*320+Math.round(160-footCenter);
      if(left<col*320||left+width>(col+1)*320)throw Error(`Clipped Lv${tier} frame ${col}`);
      layers.push({input,left,top:360-height});
    }
    const dest=`sprites/monk-idle/lv${tier}.webp`;
    await sharp({create:{width:640,height:384,channels:4,background:'#00000000'}})
      .composite(layers).webp({lossless:true}).toFile(dest);
    console.log(dest);
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
