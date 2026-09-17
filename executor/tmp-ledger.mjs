import bs58 from "bs58";
import { PUMPFUN_PROGRAM_ID } from "./snipe-venue-pumpfun.mjs";
const RPC="https://api.mainnet-beta.solana.com";
const call=async(m,p)=>{for(let i=0;i<4;i++){try{const r=await(await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})})).json();if(r.result!==undefined)return r;}catch{}await new Promise(r=>setTimeout(r,900));}return{};};
const W="6cZ1jbmP8uTPd6cUQbPzvBwWGputfSqqEAo6gHwCPZBn";
const BUY2="b817ee6167c5d33d", SELL2="5df6823ce7e940b2";
// pull the whole history
let before, all=[];
for(let p=0;p<12;p++){
  const s=(await call("getSignaturesForAddress",[W,{limit:100,before}])).result||[];
  if(!s.length)break; all.push(...s); before=s[s.length-1].signature;
  if(s.length<100)break;
}
console.log(`burner has ${all.length} transactions on record\n`);
const events=[];
let fetched=0, fees=0n;
for(const s of all){
  const tx=(await call("getTransaction",[s.signature,{maxSupportedTransactionVersion:0,encoding:"jsonParsed"}])).result;
  if(!tx)continue; fetched++;
  fees+=BigInt(tx.meta.fee);
  if(s.err)continue;
  const keys=tx.transaction.message.accountKeys.map(k=>k.pubkey);
  const flat=[...tx.transaction.message.instructions,...(tx.meta?.innerInstructions||[]).flatMap(g=>g.instructions)];
  let side=null;
  for(const ix of flat){
    if(ix.programId!==PUMPFUN_PROGRAM_ID)continue;
    const d=ix.data?Buffer.from(bs58.decode(ix.data)):null; if(!d||d.length<8)continue;
    const disc=d.subarray(0,8).toString("hex");
    if(disc===BUY2)side="buy"; else if(disc===SELL2)side="sell";
  }
  if(!side)continue;
  const i=keys.indexOf(W);
  const solDelta=tx.meta.postBalances[i]-tx.meta.preBalances[i];
  // which mint, and how many tokens moved into/out of the burner
  let mint=null, qty=0n, dec=6;
  const pre=new Map((tx.meta.preTokenBalances||[]).map(b=>[b.accountIndex,b]));
  for(const b of [...(tx.meta.postTokenBalances||[])]){
    if(b.owner!==W)continue;
    const before2=BigInt(pre.get(b.accountIndex)?.uiTokenAmount.amount??"0");
    const after=BigInt(b.uiTokenAmount.amount);
    if(after!==before2){ mint=b.mint; qty=after-before2; dec=b.uiTokenAmount.decimals; }
  }
  for(const b of (tx.meta.preTokenBalances||[])){
    if(mint||b.owner!==W)continue;
    const after=BigInt((tx.meta.postTokenBalances||[]).find(x=>x.accountIndex===b.accountIndex)?.uiTokenAmount.amount??"0");
    const before2=BigInt(b.uiTokenAmount.amount);
    if(after!==before2){ mint=b.mint; qty=after-before2; dec=b.uiTokenAmount.decimals; }
  }
  if(!mint)continue;
  events.push({side,mint,solDelta,qty,dec,at:s.blockTime,sig:s.signature});
}
events.sort((a,b)=>a.at-b.at);
console.log(`pump.fun buy_v2/sell_v2 by the burner: ${events.length} (of ${fetched} fetched)`);
console.log(`total network fees paid across all ${fetched}: ${(Number(fees)/1e9).toFixed(6)} SOL\n`);
// pair them up per mint, FIFO
const open=new Map(); const trades=[];
for(const e of events){
  if(e.side==="buy"){ open.set(e.mint,{cost:-e.solDelta, at:e.at, qty:e.qty, sig:e.sig}); }
  else { const o=open.get(e.mint); if(!o){trades.push({mint:e.mint,unmatchedSell:e.solDelta});continue;}
    trades.push({mint:e.mint, costLamports:o.cost, proceedsLamports:e.solDelta,
      realized:e.solDelta-o.cost, heldSec:e.at-o.at, entryAt:o.at, exitAt:e.at});
    open.delete(e.mint); }
}
console.log("CLOSED ROUND TRIPS (chain truth, SOL, net of the curve's fees; network fee not included)\n");
console.log("  entry cost   proceeds    realized    %       held      mint");
let wins=0,losses=0,sum=0;
for(const t of trades.filter(x=>x.realized!==undefined)){
  const c=t.costLamports/1e9, p=t.proceedsLamports/1e9, r=t.realized/1e9;
  const pct=(r/c)*100; sum+=r; r>0?wins++:losses++;
  console.log(`  ${c.toFixed(4).padStart(9)}  ${p.toFixed(4).padStart(9)}  ${(r>0?"+":"")+r.toFixed(4).padStart(8)}  ${(pct>0?"+":"")+pct.toFixed(1).padStart(6)}%  ${String(t.heldSec)+"s"} `.padEnd(62)+`${t.mint.slice(0,14)}…`);
}
console.log(`\n  ${wins} up, ${losses} down of ${wins+losses}   ·   net realized ${(sum>0?"+":"")+sum.toFixed(4)} SOL`);
const still=[...open.entries()];
console.log(`\nSTILL OPEN: ${still.length}`);
for(const [m,o] of still) console.log(`  cost ${(o.cost/1e9).toFixed(4)} SOL, open ${Math.floor((Date.now()/1000-o.at)/60)}m   ${m.slice(0,14)}…`);
// hold-time signal
const closed=trades.filter(x=>x.realized!==undefined);
if(closed.length){
  const byHold=[...closed].sort((a,b)=>a.heldSec-b.heldSec);
  console.log(`\nHOLD TIME: shortest ${byHold[0].heldSec}s  median ${byHold[Math.floor(byHold.length/2)].heldSec}s  longest ${byHold[byHold.length-1].heldSec}s`);
  const q=(arr)=>arr.reduce((a,b)=>a+b.realized,0)/1e9;
  const half=Math.ceil(byHold.length/2);
  console.log(`  quicker half (n=${half}): ${q(byHold.slice(0,half)).toFixed(4)} SOL`);
  console.log(`  slower  half (n=${byHold.length-half}): ${q(byHold.slice(half)).toFixed(4)} SOL`);
  const bySize=[...closed].sort((a,b)=>a.costLamports-b.costLamports);
  console.log(`\nSIZE: smallest ${(bySize[0].costLamports/1e9).toFixed(4)}  largest ${(bySize[bySize.length-1].costLamports/1e9).toFixed(4)} SOL`);
  console.log(`  smaller half: ${q(bySize.slice(0,half)).toFixed(4)} SOL     larger half: ${q(bySize.slice(half)).toFixed(4)} SOL`);
}
