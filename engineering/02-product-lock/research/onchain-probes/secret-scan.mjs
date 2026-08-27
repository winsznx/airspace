import fs from "fs"; import path from "path";
const ROOT=process.argv[2] ?? process.cwd();
const SKIP=new Set(["node_modules",".git","out","cache","lib","botkit","sdkprobe"]);
// The actual secrets we must ensure never leaked.
const wallets=JSON.parse(fs.readFileSync(path.join(ROOT,".wallets.json"),"utf8"));
const secrets=Object.values(wallets).map(w=>w.private_key.toLowerCase());
const secretsNoPrefix=secrets.map(s=>s.replace(/^0x/,""));

const files=[];
(function walk(d){
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
    if(SKIP.has(e.name)) continue;
    const p=path.join(d,e.name);
    if(e.isDirectory()) walk(p); else files.push(p);
  }
})(ROOT);

console.log("files scanned:",files.length);
let leaks=0, mnemonic=0, apikeys=0;
const BIP39=/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;
const APIKEY=/(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/;
for(const f of files){
  const rel=path.relative(ROOT,f);
  let t; try{ t=fs.readFileSync(f,"utf8"); }catch{ continue; }
  const lo=t.toLowerCase();
  for(let i=0;i<secrets.length;i++){
    if(lo.includes(secrets[i]) || lo.includes(secretsNoPrefix[i])){
      if(rel===".wallets.json") continue;
      console.log(`  *** PRIVATE KEY LEAK: ${rel} (wallet index ${i})`); leaks++;
    }
  }
  if(BIP39.test(t) && /mnemonic|seed phrase/i.test(t)){ console.log(`  ? possible mnemonic: ${rel}`); mnemonic++; }
  const m=APIKEY.exec(t); if(m){ console.log(`  ? possible API key/token: ${rel} -> ${m[0].slice(0,12)}...`); apikeys++; }
}
console.log(`\nprivate-key leaks outside .wallets.json: ${leaks}`);
console.log(`possible mnemonics: ${mnemonic}`);
console.log(`possible API keys/tokens: ${apikeys}`);

// Anything that LOOKS like a key (0x+64hex) in docs/evidence -- classify it.
console.log("\n--- 0x+64hex strings in tracked-candidate files (classification) ---");
const RE=/0x[0-9a-fA-F]{64}/g;
const kinds={};
for(const f of files){
  const rel=path.relative(ROOT,f);
  if(!/\.(md|json|txt|sol|mjs|toml)$/.test(rel)) continue;
  if(rel===".wallets.json") continue;
  let t; try{ t=fs.readFileSync(f,"utf8"); }catch{ continue; }
  for(const m of t.match(RE)||[]){
    const lo=m.toLowerCase();
    const isSecret=secrets.includes(lo);
    const k=isSecret?"SECRET":"public (txhash/marketId/policyHash/salt)";
    kinds[k]=(kinds[k]||0)+1;
  }
}
console.log(JSON.stringify(kinds,null,1));
