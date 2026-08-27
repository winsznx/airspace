import { createPublicClient, http } from "viem";
import * as mod from "@somnia-chain/reactivity";
const RPC="https://dream-rpc.somnia.network";
const PRE="0x0000000000000000000000000000000000000100";
const OWNER="0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc";
const abi=mod.SomniaReactivityPrecompileABI;
const sub=abi.find(e=>e.name==="subscribe");
console.log("subscribe inputs:", JSON.stringify(sub.inputs));
const pub=createPublicClient({chain:{id:50312,name:"s",nativeCurrency:{name:"STT",symbol:"STT",decimals:18},rpcUrls:{default:{http:[RPC]}}},transport:http(RPC)});
const t=sub.inputs[0].components.map(c=>c.name);
console.log("tuple fields:", t.join(", "));
const arg={};
for(const c of sub.inputs[0].components){
  if(c.type==="address") arg[c.name]= c.name==="handler"? OWNER : "0x0000000000000000000000000000000000000000";
  else if(c.type.startsWith("bytes32[")) arg[c.name]=["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(64),"0x"+"0".repeat(64),"0x"+"0".repeat(64)];
  else if(c.type==="bytes4") arg[c.name]="0x53edf33d";
  else if(c.type==="bool") arg[c.name]=false;
  else if(c.type.startsWith("uint")) arg[c.name]= c.name==="gasLimit"?10000000n : (c.name==="maxFeePerGas"?20000000000n:0n);
  else arg[c.name]=0n;
}
if("emitter" in arg) arg.emitter="0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
console.log("arg:", JSON.stringify(arg,(k,v)=>typeof v==="bigint"?v.toString():v));
try{
  const r=await pub.simulateContract({account:OWNER,address:PRE,abi,functionName:"subscribe",args:[arg]});
  console.log("SIMULATION SUCCEEDED -> the 32 STT floor is CLIENT-SIDE ONLY (owner has 29.17 STT)");
}catch(e){
  console.log("SIMULATION REVERTED ->", String(e.shortMessage||e.message).slice(0,300));
}
