const RPC="https://dream-rpc.somnia.network";
const MOD="0x3ecC694Cef705358864a646142ac17A90E29e388";
const pad=(n)=>BigInt(n).toString(16).padStart(64,"0");
const w=(h,i)=>"0x"+h.slice(2+i*64,2+(i+1)*64);
let idc=0;
const call=async(to,data)=>(await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({jsonrpc:"2.0",id:++idc,method:"eth_call",params:[{to,data},"latest"]})}).then(r=>r.json())).result;
const rec=(id)=>call(MOD,"0x7564912b"+pad(id));
const alive=async(id)=>{const r=await rec(id); return !!r&&r!=="0x"&&BigInt(w(r,9))!==0n;};
let lo=0xb000n,hi=0xb000n;
while(await alive(hi)){lo=hi;hi=hi*2n; if(hi>0x100000n)break;}
while(lo+1n<hi){const mid=(lo+hi)/2n; if(await alive(mid))lo=mid; else hi=mid;}
const bn=parseInt((await (await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})})).json()).result,16);
const now=Math.floor(Date.now()/1000);
console.log("block",bn,"top marketId 0x"+lo.toString(16),"now",now);
const TABLE=[60,300,900,1800,3600,14400,86400];
const cad=(ts,ex)=>{const win=ex-ts;for(const C of TABLE)if(C>=win&&ex%C===0)return C;return 0;};
const out=[];
const ids=[];for(let i=0n;i<250n;i++)ids.push(lo-i);
for(let i=0;i<ids.length;i+=25){
  const b=await Promise.all(ids.slice(i,i+25).map(async id=>({id,r:await rec(id)})));
  for(const {id,r} of b){
    if(!r||r==="0x")continue;
    const pool="0x"+w(r,9).slice(26); if(BigInt(pool)===0n)continue;
    const ts=Number(BigInt(w(r,12))),ex=Number(BigInt(w(r,13)));
    if(ex<=now+120)continue;
    out.push({id:"0x"+id.toString(16).padStart(64,"0"),short:"0x"+id.toString(16),creator:"0x"+w(r,7).slice(26),
      collateral:"0x"+w(r,3).slice(26),pool,ts,ex,win:ex-ts,cad:cad(ts,ex),left:ex-now});
  }
}
out.sort((a,b)=>a.cad-b.cad||a.left-b.left);
console.log("\nlive markets (expiry > now+120):");
for(const m of out) console.log(`  ${m.short.padEnd(8)} cad=${String(m.cad).padStart(6)}s win=${String(m.win).padStart(6)} left=${String(m.left).padStart(6)}s pool=${m.pool} creator=${m.creator.slice(0,10)}`);
// pick two in the SAME domain
const byDom={};
for(const m of out){const k=`${m.creator}|${m.collateral}|${m.cad}`;(byDom[k]=byDom[k]||[]).push(m);}
console.log("\ndomains with >=2 live markets:");
for(const [k,v] of Object.entries(byDom)) if(v.length>=2) console.log(`  cad=${k.split("|")[2]} n=${v.length} -> ${v.map(x=>x.short).join(",")}`);
