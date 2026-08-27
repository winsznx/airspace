const RPC="https://dream-rpc.somnia.network";
const MOD="0x3ecC694Cef705358864a646142ac17A90E29e388";
const pad=(n)=>BigInt(n).toString(16).padStart(64,"0");
const w=(h,i)=>"0x"+h.slice(2+i*64,2+(i+1)*64);
let idc=0;
async function call(data){
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:++idc,method:"eth_call",params:[{to:MOD,data},"latest"]})}).then(r=>r.json());
  return r.result;
}
const rec=(id)=>call("0x7564912b"+pad(id));
const alive=async(id)=>{const r=await rec(id); return !!r && r!=="0x" && BigInt(w(r,9))!==0n;};
// binary search the top of the sequential marketId counter
let lo=0xb000n, hi=0xb000n;
while(await alive(hi)) { lo=hi; hi=hi*2n; if(hi>0x100000n) break; }
while(lo+1n<hi){ const mid=(lo+hi)/2n; if(await alive(mid)) lo=mid; else hi=mid; }
console.log("highest live marketId: 0x"+lo.toString(16), "=", lo.toString());
const ids=[]; for(let i=0n;i<400n;i++) ids.push(lo-i);
const rows=[];
const CONC=25;
for(let i=0;i<ids.length;i+=CONC){
  const batch=await Promise.all(ids.slice(i,i+CONC).map(async id=>({id,r:await rec(id)})));
  for(const {id,r} of batch){
    if(!r||r==="0x") continue;
    const pool="0x"+w(r,9).slice(26); if(BigInt(pool)===0n) continue;
    rows.push({id:"0x"+id.toString(16), collateral:"0x"+w(r,3).slice(26), venue:w(r,5),
      creator:"0x"+w(r,7).slice(26), pool, ts:Number(BigInt(w(r,12))), ex:Number(BigInt(w(r,13)))});
  }
}
console.log("markets read from chain:",rows.length);
const cv={}; for(const r of rows){ (cv[r.creator]=cv[r.creator]||new Set()).add(r.venue); }
console.log("\ncreator -> venue (1:1?)");
for(const [c,v] of Object.entries(cv)) console.log("  ",c,"venues:",v.size,[...v].map(x=>x.slice(0,12)).join(","));
const dom={};
for(const r of rows){ const iv=r.ex-r.ts; const k=`${r.creator}|${r.collateral}|${iv}`;
  (dom[k]=dom[k]||{n:0,pools:new Set(),ids:[]}); dom[k].n++; dom[k].pools.add(r.pool); dom[k].ids.push(r.id); }
console.log("\nstructural domains (creator|collateral|intervalSec):");
for(const [k,v] of Object.entries(dom).sort((a,b)=>b[1].n-a[1].n)){
  const p=k.split("|");
  console.log(`  interval=${String(p[2]).padStart(6)}s markets=${String(v.n).padStart(4)} pools=${String(v.pools.size).padStart(4)} creator=${p[0].slice(0,10)} sample=${v.ids.slice(0,4).join(",")}`);
}
console.log("\ndistinct intervals seen:", [...new Set(rows.map(r=>r.ex-r.ts))].sort((a,b)=>a-b).join(", "));
