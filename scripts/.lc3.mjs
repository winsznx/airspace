import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http } from "viem";
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const db=createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const RPC="https://dream-rpc.somnia.network";
const pub=createPublicClient({chain:{id:50312,name:"S",nativeCurrency:{name:"STT",symbol:"STT",decimals:18},rpcUrls:{default:{http:[RPC]}}},transport:http(RPC)});
const abi=JSON.parse(fs.readFileSync("contracts/out/AirspacePortfolio.sol/AirspacePortfolio.json","utf8")).abi;
const P="0x2839EA7138c1cB783272041D55Ed6e9e29f2D4Bc";
const DOM="0xecad341196fc789ff26611e774c63542fba1a40e8bec10e253bcfe7fb7c5f784";
for (let i=0;i<10;i++){
  const [usage, reserved] = await Promise.all([
    pub.readContract({address:P,abi,functionName:"domainRiskUsage",args:[DOM]}),
    pub.readContract({address:P,abi,functionName:"reservedCollateral"}),
  ]);
  const { data: jobs } = await db.from("reconciliation_jobs").select("status,kind,last_error").limit(500);
  const c={}; for (const j of jobs??[]) c[`${j.kind}:${j.status}`]=(c[`${j.kind}:${j.status}`]??0)+1;
  const err=(jobs??[]).find(j=>j.last_error)?.last_error;
  console.log(`usage ${usage}  reserved ${reserved}  ${JSON.stringify(c)}${err?"  e="+err.slice(0,60):""}`);
  await new Promise(r=>setTimeout(r,60000));
}
