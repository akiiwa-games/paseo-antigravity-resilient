import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const frames=readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const mode=process.argv[3];
const SSE_EOF_ERROR='API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF';
createInterface({input:process.stdin}).on('line',async()=>{
  let streamedResponse='';
  for(const rawFrame of frames){
    const frame=structuredClone(rawFrame);
    const step=frame.step_update;
    if(step?.step_type==='agent_response')streamedResponse+=step.text_delta??'';
    if(mode==='missing-final' && step?.step_index===5) continue;
    if(mode==='partial-final' && step?.step_index===5 && step.text_delta){
      if(globalThis.startedFinal) continue;
      globalThis.startedFinal=true;
    }
    if(mode==='missing-tool-done' && step?.step_type==='tool' && step.state==='DONE') continue;
    if(mode==='sticky-eof' && frame.event==='result'){
      frame.result.status='ERROR';
      frame.result.error=SSE_EOF_ERROR;
    }
    const line=JSON.stringify(frame)+'\n';
    // Exercise actual pipes, readline fragmentation and multiple updates.
    process.stdout.write(line.slice(0,17));
    process.stdout.write(line.slice(17));
    if((mode==='partial-error-tail' && step?.step_index===5 && step.text_delta) ||
       (mode==='unstreamed-error' && frame.event==='init')){
      process.stdout.write(JSON.stringify({event:'result',result:{
        conversation_id:'fixture-conversation',status:'ERROR',error:SSE_EOF_ERROR,
        response:streamedResponse+' An unfinished response tail.',
      }})+'\n');
      return;
    }
    if(mode==='interrupted-after-tool' && step?.step_index===2 && step.state==='DONE'){
      process.stdout.write(JSON.stringify({
        event:'result',
        result:{
          conversation_id:'fixture-conversation',
          status:'ERROR',
          error:SSE_EOF_ERROR,
          response:'PRE_TOOL_MARKER: Executing `python probe.py` now.\n',
        },
      })+'\n');
      return;
    }
    if(step?.step_type==='tool'&&step.state==='ACTIVE'){
      if(mode==='hold-tool')return;
      if(mode==='failed-tool'){
        process.stdout.write(JSON.stringify({event:'result',result:{status:'ERROR',error:'test tool failure'}})+'\n');
        return;
      }
    }
    await new Promise(r=>setTimeout(r,1));
  }
});
