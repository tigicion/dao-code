import {describe,it,expect} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {CuratedMemoryStore} from "./curated_store.js";
const exec=promisify(execFile);
describe("real multi-process curated writes",()=>{
 it("does not lose concurrent updates from independent processes",async()=>{
  const home=mkdtempSync(path.join(os.tmpdir(),"dao-hermes-concurrent-"));
  const store=new CuratedMemoryStore(home);
  try{
   const module=path.resolve("src/memory/curated_store.ts");
   await Promise.all(Array.from({length:6},(_,i)=>exec(process.execPath,["--import","tsx","--input-type=module","-e",`import {CuratedMemoryStore} from ${JSON.stringify(module)};const s=new CuratedMemoryStore(${JSON.stringify(home)});try{const r=s.apply('memory',[{action:'add',content:'process-${i}'}]);if(!r.success)throw new Error(JSON.stringify(r));}finally{s.close();}`],{timeout:15000})));
   expect(store.read("memory").sort()).toEqual(Array.from({length:6},(_,i)=>`process-${i}`));
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
 },20000);
});
