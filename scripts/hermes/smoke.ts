import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const home=mkdtempSync(path.join(os.tmpdir(),"dao-hermes-smoke-"));
try {
 const env={...process.env,DAO_HOME:home};
 const binary=process.argv[2];
 const exe=binary??process.execPath;
 const prefix=binary?[]:[path.resolve("dist/index.js")];
 const run=(args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args],{env,encoding:"utf8",timeout:30000}));
 const status=run(["memory","status"]);
 if(status.engine!=="hermes"||status.memory.length)throw new Error("Unexpected initial profile");
 const other=run(["memory","status","--profile","isolated"]);
 if(status.home===other.home)throw new Error("Profile alias");
 const plan=run(["memory","migrate","plan","--legacy-home",home]);
 const saved=JSON.parse(readFileSync(plan.file,"utf8"));
 if(!saved.sources||saved.targets.memory!=="")throw new Error("Invalid migration plan");
 run(["memory","migrate","apply",plan.file,"--accept",plan.digest,"--offline"]);
 const verify=run(["memory","migrate","verify",plan.file]);
 if(!verify.success)throw new Error("Migration verify failed");
 console.log(JSON.stringify({runtime:binary?"bun-standalone":"node",status:"passed",profiles:2,migration:"plan/apply/verify",actual_user_memory:"untouched"}));
}finally{rmSync(home,{recursive:true,force:true});}
