const RPC="https://dream-rpc.somnia.network";
const MC="0x94D963B6670AB96E78C8d0C46ca35D196d606EFE";
const MC2="0xee3aff92812a2cb7bf801b500687bc97b55cab34";
const MOD="0x3ecC694Cef705358864a646142ac17A90E29e388";
const MID="0x0000000000000000000000000000000000000000000000000000000000000130"; // real market on MC
const MID2="0x000000000000000000000000000000000000000000000000000000000000b225"; // real market on MC2
const U32="0000000000000000000000000000000000000000000000000000000000000007";
async function call(to,data){
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to,data},"latest"]})}).then(r=>r.json());
  return r.result ?? null;
}
const selsMC="038b290d 07b18bde 092a7ac1 121193f0 1270be6c 1e67e54c 1fff8caa 23188024 2ae67283 30e93068 345f0ffa 34f1f06e 358ce257 56282f8a 5b1b894c 69dab962 6b6c0774 8a90e850 a18b7256 b2dfa667 ddd09d70 dfaea094 ec979082 eec23fa5 54dc6a89 02fabce3 012a60ad 901fb289 1d42c867 3af3671b 5ae1f40d 7dbb6241 11c5096f 9b7051bb 1e9cef4f 0eeb62c7 09756719 62fe548f 495867ab".split(" ");
const selsMC1="03eadcfc 06e7ac90 07b18bde 1ee91fa4 21235083 23188024 297f59fb 2ed49d5a 30e93068 34f1f06e 358ce257 71e4ae3b 7564912b 79e12f66 88ec7934 8a90e850 9360d325 9e15c572 a18b7256 a1e79fee a63fd2a7 ae3332fa b2dfa667 bf68b816 cf3c0ade e4711fd6 ea623a3c f2f4eb26 fba5be45 78b8ff49 17198a9f 0d17d65b 30aff9db 3cf097b3 57506303 565b8180 1da01b01 309f1279 2040dc97 ad0b27fb 09daa22f 048adc13 6560d81b e9a1cf69 075cd713 94f9fdc7 916115d6 16f0115b b23de6cd c984d9b3".split(" ");
async function sweep(label,addr,sels,mid){
  console.log(`\n### ${label} (${addr})`);
  for(const s of sels){
    const withMid = await call(addr,"0x"+s+mid.slice(2));
    const withU32 = await call(addr,"0x"+s+U32);
    const noArg   = await call(addr,"0x"+s);
    const hits=[];
    if(withMid && withMid!=="0x") hits.push(`bytes32->${withMid.slice(0,74)}`);
    if(withU32 && withU32!=="0x") hits.push(`uint32->${withU32.slice(0,74)}`);
    if(noArg && noArg!=="0x")     hits.push(`()->${noArg.slice(0,74)}`);
    if(hits.length) console.log(`  0x${s}  ${hits.join("  |  ")}`);
  }
}
await sweep("MarketCreator venue0x6797",MC,selsMC1,MID);
await sweep("MarketCreator venue0x1a1e",MC2,selsMC,MID2);
