import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Session} from '../server/internal/session.ts';
import {MODES,DEFAULT_MODE} from '../server/internal/catalog.ts';
import {NativeReasoningTail} from '../server/internal/native-reasoning.ts';
import type {ProviderEvent} from '@getpaseo/plugin/server/provider';

const fixture=path.resolve('test/fixtures/agy-1.4.12-stream.jsonl');
const frames=readFileSync(fixture,'utf8').trim().split('\n').map(line=>JSON.parse(line));
const response=frames.at(-1).result.response;
const config={cwd:tmpdir(),env:process.env as Record<string,string>,mcpServers:{},model:'fixture',mode:'full-access',settings:{},persist:true};
const catalog={models:[{id:'fixture',label:'fixture'}],modes:MODES,defaultModel:'fixture',defaultMode:DEFAULT_MODE};
async function until(predicate:()=>boolean){
  const deadline=Date.now()+7000;
  while(!predicate()){
    if(Date.now()>deadline) throw new Error('Real driver did not settle');
    await new Promise(r=>setTimeout(r,10));
  }
}
for(const mode of ['complete','missing-final','partial-final','missing-tool-done','sticky-eof']){
  test(`synthetic agy 1.4.12 fixture through a real child pipe: ${mode}`,async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'agy-stream-'));
    const events:ProviderEvent[]=[];
    const session=new Session('probe',process.execPath,
      [path.resolve('test/fixtures/replay-stream.mjs'),fixture,mode],
      process.env as Record<string,string>,config,undefined,catalog,e=>events.push(e),
      {storeDir:dir,brainDir:dir,autoCompactEnabled:false});
    try{
      await session.prompt({clientMessageId:'probe',delivery:'auto',input:{type:'message',content:[{type:'text',text:'fixture'}]}});
      await until(()=>events.some(e=>e.type==='session.turn' && e.state==='completed'));
      const items=new Map<string,any>();
      for(const e of events) if(e.type==='timeline.item')items.set(e.item.id,e.item);
      assert.equal([...items.values()].filter(i=>i.type==='assistant_message').map(i=>i.text).join(''),response,
        'complete final response exactly once, including pre-tool progress');
      assert.equal([...items.values()].filter(i=>i.type==='tool_call'&&i.status==='running').length,0);
      const progress=events.findIndex(e=>e.type==='timeline.item'&&e.item.type==='assistant_message'&&e.item.text.includes('PRE_TOOL_MARKER'));
      const firstTool=events.findIndex(e=>e.type==='timeline.item'&&e.item.type==='tool_call');
      assert.ok(progress>=0&&progress<firstTool,'progress is emitted before command results, not buffered until result');
      assert.equal(events.filter(e=>e.type==='session.turn'&&e.state==='completed').length,1);
    }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
  });
}

for(const mode of ['interrupted-after-tool','partial-error-tail','unstreamed-error']){
test(`real pipe ${mode} retries once and fails instead of falsely completing`,async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'agy-interrupted-tool-'));
  const events:ProviderEvent[]=[];
  const session=new Session('probe-interrupted',process.execPath,
    [path.resolve('test/fixtures/replay-stream.mjs'),fixture,mode],
    process.env as Record<string,string>,config,undefined,catalog,e=>events.push(e),
    {storeDir:dir,brainDir:dir,autoCompactEnabled:false,streamInterruptRetryDelayMs:5});
  try{
    await session.prompt({clientMessageId:'probe-interrupted',delivery:'auto',input:{type:'message',content:[{type:'text',text:'fixture'}]}});
    await until(()=>events.some(e=>e.type==='session.turn'&&(e.state==='failed'||e.state==='completed')));
    assert.equal(events.some(e=>e.type==='session.turn'&&e.state==='completed'),false,
      'partial result.response is not proof of a completed response step');
    const failure=events.find(e=>e.type==='session.turn'&&e.state==='failed');
    assert.ok(failure&&failure.type==='session.turn'&&failure.error?.message.includes('streamGenerateContent'));
  }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
});
}

test('a real CLI process that never initializes fails and is stopped',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'agy-start-'));
  const events:ProviderEvent[]=[];
  const session=new Session('startup',process.execPath,['-e','setInterval(()=>{},1000)','--'],process.env as Record<string,string>,
    config,undefined,catalog,e=>events.push(e),{storeDir:dir,brainDir:dir,startupTimeoutMs:80,autoCompactEnabled:false});
  try{
    await session.prompt({clientMessageId:'start',delivery:'auto',input:{type:'message',content:[{type:'text',text:'fixture'}]}});
    const failure=events.find(e=>e.type==='session.turn'&&e.state==='failed');
    assert.ok(failure&&failure.type==='session.turn'&&failure.error?.message.includes('did not initialize'));
  }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('native reasoning tail skips history and preserves split UTF-8 rows',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'agy-thought-'));
  try{
    const file=path.join(dir,'transcript.jsonl');
    const row=(step:number,text:string)=>JSON.stringify({type:'PLANNER_RESPONSE',step_index:step,thinking:text})+'\n';
    writeFileSync(file,row(1,'old thought'));
    const tail=new NativeReasoningTail(file);
    const next=Buffer.from(row(3,'正在检查命令输出'));
    appendFileSync(file,next.subarray(0,next.length-7));
    assert.deepEqual(tail.read(),[]);
    appendFileSync(file,next.subarray(next.length-7));
    assert.deepEqual(tail.read(),[{step:3,text:'正在检查命令输出'}]);
    assert.deepEqual(tail.read(),[]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const mode of ['hold-tool','failed-tool']){
  test(`real pipe tool settles on ${mode==='hold-tool'?'cancel':'failure'}`,async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'agy-terminal-'));
    const events:ProviderEvent[]=[];
    const session=new Session('terminal',process.execPath,[path.resolve('test/fixtures/replay-stream.mjs'),fixture,mode],
      process.env as Record<string,string>,config,undefined,catalog,e=>events.push(e),
      {storeDir:dir,brainDir:dir,autoCompactEnabled:false});
    try{
      await session.prompt({clientMessageId:'tool',delivery:'auto',input:{type:'message',content:[{type:'text',text:'fixture'}]}});
      await until(()=>events.some(e=>e.type==='timeline.item'&&e.item.type==='tool_call'&&e.item.status==='running'));
      if(mode==='hold-tool')await session.interrupt('cancel');
      else await until(()=>events.some(e=>e.type==='session.turn'&&e.state==='failed'));
      const tools=events.filter(e=>e.type==='timeline.item'&&e.item.type==='tool_call');
      const last=tools.at(-1);
      assert.ok(last?.type==='timeline.item'&&last.item.type==='tool_call');
      assert.equal(last.item.status,mode==='hold-tool'?'canceled':'failed');
    }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
  });
}
