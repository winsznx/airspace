const RPC="https://dream-rpc.somnia.network";
const MOD="0x3ecC694Cef705358864a646142ac17A90E29e388";
const CREATORS={"MC-venue0x6797":"0x94D963B6670AB96E78C8d0C46ca35D196d606EFE","MC-venue0x1a1e":"0xee3aff92812a2cb7bf801b500687bc97b55cab34"};
const MSEL="0x7564912b".slice(2), SSEL="0xbc4a4912".slice(2);
const pad=(n)=>BigInt(n).toString(16).padStart(64,"0");
async function call(to,data){
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to,data},"latest"]})}).then(r=>r.json());
  return r.result ?? null;
}
function w(hex,i){ return "0x"+hex.slice(2+i*64,2+(i+1)*64); }
async function run(){
for(const [label,MC] of Object.entries(CREATORS)){
  console.log("\n### "+label+"  "+MC);
  for(let sid=1; sid<=12; sid++){
    const fwd=await call(MC,"0x88ec7934"+pad(sid));
    if(!fwd || fwd==="0x" || BigInt(fwd)===0n) continue;
    const mid="0x"+BigInt(fwd).toString(16).padStart(64,"0");
    const ser=await call(MC,"0x"+SSEL+pad(sid));
    let asset="?",interval="?";
    if(ser && ser!=="0x"){
      const off=Number(BigInt(w(ser,1)));            // string offset
      const len=Number(BigInt("0x"+ser.slice(2+off*2, 2+off*2+64)));
      asset=Buffer.from(ser.slice(2+off*2+64, 2+off*2+64+len*2),"hex").toString();
      interval=BigInt(w(ser,3)).toString();
    }
    const rec=await call(MOD,"0x"+MSEL+mid.slice(2));
    let creator="?",expiry="?",pool="?";
    if(rec && rec!=="0x"){ creator="0x"+w(rec,7).slice(26); pool="0x"+w(rec,9).slice(26); expiry=BigInt(w(rec,13)).toString(); }
    const ok = creator.toLowerCase()===MC.toLowerCase();
    console.log(`  series ${String(sid).padStart(2)} -> marketId ${mid.slice(-6)}  asset=${asset.padEnd(4)} interval=${String(interval).padEnd(6)} | module.creator matches: ${ok}  expiry=${expiry} pool=${pool}`);
  }
}
}
run();
