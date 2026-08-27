const RPC="https://dream-rpc.somnia.network";
const MOD="0x3ecC694Cef705358864a646142ac17A90E29e388";
const MID="0x0000000000000000000000000000000000000000000000000000000000000130";
const sels=`0118fc5b 0276f00f 03bc8d8d 065efe18 06c65d9f 0a7e8973 0a9c99db 0ab37779 0b135d3f 0c0e8cd3 0dd66e29 0e7e63ed 10069769 128eb04b 12c7e847 134a357f 139f0769 1453fe17 147607c3 16899d27 178c44c9 17a10e13 185649d7 198c3164 1f2a2005 1f7f5e51 20594553 21eed1cd 24427007 286faa3f 2a32bee9 2a875269 2ab1e079 2c805af5 2ccfbe57 2d02d3a5 2d90baf5 2dd48909 2e711c0f 2f55a60b 33e36da5 35de7d95 38eb3920 3c24e71d 3cc57b21 3d312f6d 3e9e4eb7 3f3ce82b 3f7c979b 4409b41a 47dfb781 4843527f 4ef39b75 4efe024a 5274afe7 559bbbc8 55ec8423 582515c7 5a1042ab 5abbc712 5b1ffcf2 6221cfe3 626cb257 665d7b0e 687d0a78 689cb3f8 6a88b791 703e46dd 71139057 7b0d833f 7d3c9d6e 7e61c6bd 7f4c824d 81613c31 84c4e5c9 84f093c0 85604091 88cb9474 89dde31d 8e3aeebc 8f4e6f37 918d1cab 9996b315 a8f2ecb1 a998d6d8 b2d3eae1 b398979f b3f05b97 b6354afe b8652c84 bd0f1221 bdc95715 bddb5def bdf3c2b5 c05c5f47 c212a4cd c3dc7ca0 c4b84cd7 c62fe0cf c7266f5b c9589fc5 caa855b3 ccd79ec5 ce657732 d114a0c7 d55be8c6 d6bda275 d8ac9325 d92e233d da8a1461 dbc84587 dec0f867 df88ba21 e09d5da9 e48defb8 e696ff47 f5b7ba39 f77ab474 f8c21535 fbf66df1 fe4f32a9`.split(/\s+/);
async function call(data){
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:MOD,data},"latest"]})}).then(r=>r.json());
  return r.result ?? null;
}
function looksLikeString(hex){
  if(!hex||hex.length<2+64*3) return null;
  const off=Number(BigInt("0x"+hex.slice(2,66)));
  if(off!==32) return null;
  const len=Number(BigInt("0x"+hex.slice(66,130)));
  if(len===0||len>64) return null;
  const s=Buffer.from(hex.slice(130,130+len*2),"hex").toString();
  return /^[\x20-\x7e]+$/.test(s)?s:null;
}
let hits=0;
for(const s of sels){
  const r=await call("0x"+s+MID.slice(2));
  if(!r||r==="0x") continue;
  const str=looksLikeString(r);
  const nonzero = BigInt("0x"+r.slice(2).padEnd(64,"0").slice(0,64))!==0n;
  if(str){ console.log(`  0x${s}  STRING -> "${str}"`); hits++; }
  else if(nonzero && r.length<=200){ console.log(`  0x${s}  -> ${r}`); hits++; }
}
console.log("non-trivial responders:",hits);
