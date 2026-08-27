const RPC="https://dream-rpc.somnia.network";
const MOD="0x3ecC694Cef705358864a646142ac17A90E29e388";
const pad=(n)=>BigInt(n).toString(16).padStart(64,"0");
const w=(h,i)=>"0x"+h.slice(2+i*64,2+(i+1)*64);
let idc=0;
const call=async(data)=>(await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({jsonrpc:"2.0",id:++idc,method:"eth_call",params:[{to:MOD,data},"latest"]})}).then(r=>r.json())).result;
const rec=(id)=>call("0x7564912b"+pad(id));

// Candidate on-chain canonical cadence table.
const TABLE=[60,300,900,1800,3600,14400,86400];
// RULE: smallest C in TABLE with C >= window AND expiry % C == 0. Else: no domain.
function cadenceOf(ts,ex){
  const win=ex-ts;
  for(const C of TABLE){ if(C>=win && ex%C===0) return C; }
  return 0;
}

const TOP=45732n, N=1200n;
const ids=[]; for(let i=0n;i<N;i++) ids.push(TOP-i);
const rows=[]; const CONC=30;
for(let i=0;i<ids.length;i+=CONC){
  const b=await Promise.all(ids.slice(i,i+CONC).map(async id=>({id,r:await rec(id)})));
  for(const {id,r} of b){
    if(!r||r==="0x") continue;
    const pool="0x"+w(r,9).slice(26); if(BigInt(pool)===0n) continue;
    rows.push({id:"0x"+id.toString(16),creator:"0x"+w(r,7).slice(26),collateral:"0x"+w(r,3).slice(26),
      ts:Number(BigInt(w(r,12))),ex:Number(BigInt(w(r,13))),pool});
  }
}
console.log("markets sampled:",rows.length);
const wins={}; for(const r of rows){ const win=r.ex-r.ts; wins[win]=(wins[win]||0)+1; }
console.log("\nraw window (expiry - tradingStart) distribution:");
for(const [k,v] of Object.entries(wins).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(k).padStart(6)}s : ${v}`);
const off=Object.entries(wins).filter(([k])=>!TABLE.includes(Number(k)));
console.log("\noff-cadence windows:", off.length? off.map(([k,v])=>`${k}s x${v}`).join(", ") : "none");

console.log("\n--- applying rule: smallest C>=window with expiry%C==0 ---");
const dom={}; let unresolved=0;
for(const r of rows){
  const c=cadenceOf(r.ts,r.ex);
  if(c===0){ unresolved++; console.log("  UNRESOLVED",r.id,"win",r.ex-r.ts,"expiry",r.ex); continue; }
  const k=`${r.creator}|${c}`; (dom[k]=dom[k]||{n:0,rawWins:new Set()}); dom[k].n++; dom[k].rawWins.add(r.ex-r.ts);
}
console.log("unresolved markets:",unresolved);
console.log("\ndomains after canonicalisation:");
for(const [k,v] of Object.entries(dom).sort((a,b)=>b[1].n-a[1].n)){
  const [c,cad]=k.split("|");
  console.log(`  cadence=${String(cad).padStart(6)}s markets=${String(v.n).padStart(4)} creator=${c.slice(0,10)} rawWindowsAbsorbed={${[...v.rawWins].sort((a,b)=>a-b).join(",")}}`);
}
