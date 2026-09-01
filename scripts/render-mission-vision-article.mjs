#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const ARTICLE=path.join(ROOT,"marketing","mission-vision-article");
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CARDS=[
  { card:"header",filename:"mission-vision-header.png",width:1500,height:600 },
  { card:"mission",filename:"01-mission-in-practice.png",width:1600,height:900 },
  { card:"vision",filename:"02-vision-shift.png",width:1600,height:900 },
];

if(!fs.existsSync(path.join(ARTICLE,"visuals.html"))) throw new Error("visuals.html is missing");
if(!fs.existsSync(CHROME)) throw new Error(`Google Chrome is missing at ${CHROME}`);

const mime=new Map([[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".gif","image/gif"],[".ttf","font/ttf"]]);
const server=http.createServer((request,response)=>{
  const url=new URL(request.url||"/","http://127.0.0.1");
  const relative=decodeURIComponent(url.pathname).replace(/^\/+/,"")||"marketing/mission-vision-article/visuals.html";
  const file=path.resolve(ROOT,relative);
  if(file!==ROOT&&!file.startsWith(`${ROOT}${path.sep}`)){response.writeHead(403).end("forbidden");return;}
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end("not found");return;}
  response.setHeader("Cache-Control","no-store"); response.setHeader("Content-Type",mime.get(path.extname(file).toLowerCase())||"application/octet-stream");
  fs.createReadStream(file).pipe(response);
});
const listen=()=>new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve(server.address().port));});
const runScreenshot=(command,args,output)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:["ignore","ignore","pipe"]}); let stderr="",captured=false,terminateTimer;
  const poll=setInterval(()=>{if(captured||!fs.existsSync(output)||fs.statSync(output).size<10_000)return;captured=true;terminateTimer=setTimeout(()=>child.kill("SIGTERM"),300);},100);
  const timeout=setTimeout(()=>child.kill("SIGTERM"),20_000);
  child.stderr.on("data",chunk=>{stderr+=String(chunk);}); child.once("error",reject);
  child.once("exit",code=>{clearInterval(poll);clearTimeout(timeout);clearTimeout(terminateTimer);if(captured||(fs.existsSync(output)&&fs.statSync(output).size>=10_000))resolve();else reject(new Error(stderr.slice(-3000)||`Chrome exited ${code}`));});
});

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"claude-company-mission-article-"));
try {
  const port=await listen(),outputs=[];
  for(const spec of CARDS){
    const output=path.join(ARTICLE,spec.filename),profile=path.join(temporary,`chrome-${spec.card}`);
    const url=`http://127.0.0.1:${port}/marketing/mission-vision-article/visuals.html?card=${encodeURIComponent(spec.card)}`;
    fs.rmSync(output,{force:true});
    await runScreenshot(CHROME,["--headless=new",`--user-data-dir=${profile}`,`--window-size=${spec.width},${spec.height}`,"--force-device-scale-factor=1","--hide-scrollbars","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-default-apps","--disable-extensions","--run-all-compositor-stages-before-draw","--virtual-time-budget=1200",`--screenshot=${output}`,url],output);
    if(!fs.existsSync(output)||fs.statSync(output).size<10_000) throw new Error(`${spec.filename} was not rendered`);
    outputs.push({file:path.relative(ROOT,output),bytes:fs.statSync(output).size,width:spec.width,height:spec.height});
  }
  console.log(JSON.stringify({outputs},null,2));
} finally {
  await new Promise(resolve=>server.close(resolve)).catch(()=>{}); fs.rmSync(temporary,{recursive:true,force:true});
}
