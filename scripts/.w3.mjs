import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const db=createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const rpc = async () => { const r=await fetch("https://dream-rpc.somnia.network",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})}); return BigInt((await r.json()).result); };
for (let i=0;i<30;i++){
  const { data } = await db.from("chain_cursors").select("last_block").eq("stream","portfolio-logs").maybeSingle();
  const c = {};
  for (const t of ["reservations","intents","positions"]) { const {count}=await db.from(t).select("*",{count:"exact",head:true}); c[t]=count; }
  const head = await rpc(); const cur = BigInt(data?.last_block ?? 0);
  console.log(`behind ${head-cur}  reservations ${c.reservations}  intents ${c.intents}  positions ${c.positions}`);
  if (head - cur < 3000n) { console.log("CAUGHT UP"); break; }
  await new Promise(r=>setTimeout(r,50000));
}
