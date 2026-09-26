// Adapted from Beautiful UI — Copyright (c) 2026 Shane Levine, MIT. See LICENSE.beautiful-ui.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {AnimatePresence,motion} from 'motion/react';
import {Button} from '../atoms/Button';
import {useReducedMotion} from '../../lib/motion';

function HermesConnectionMark(){
 return <svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="hermes-connection-glass" x1="8" y1="7" x2="40" y2="42" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".52" stopColor="#d7d3f4"/><stop offset="1" stopColor="#827bde"/></linearGradient></defs><path d="M24 5c4.8 0 7.7 5.7 5.1 9.8 4.6-2.1 9.9 1.2 9.9 6.2s-5.3 8.3-9.9 6.2c2.6 4.1-.3 9.8-5.1 9.8s-7.7-5.7-5.1-9.8C14.3 29.3 9 26 9 21s5.3-8.3 9.9-6.2C16.3 10.7 19.2 5 24 5Z" fill="url(#hermes-connection-glass)"/><circle cx="24" cy="21" r="4.5" fill="#1a135d"/><path d="M20.8 21h6.4M24 17.8v6.4" stroke="#f6f4ff" strokeWidth="1.4" strokeLinecap="round"/></svg>;
}

function IrisConnectionMark(){
 return <svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="iris-connection-glass" x1="10" y1="7" x2="49" y2="60" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".45" stopColor="#e9e6f6"/><stop offset=".72" stopColor="#bdb7d8"/><stop offset="1" stopColor="#716b96"/></linearGradient></defs><path d="M32 9c6 0 10 8 6 15 7-4 15 0 15 7s-8 11-15 7c4 7 0 15-7 15s-11-8-7-15c-7 4-15 0-15-7s8-11 15-7c-4-7 0-15 8-15Z" fill="url(#iris-connection-glass)"/><path d="M32 10c4 0 8 5 7 11l-7 9-7-7c-3-6 0-13 7-13Z" fill="#fff" opacity=".72"/><path d="m33 32 15-6c7 8-2 16-9 12l-5 11-6-11Z" fill="#9e9abf" opacity=".38"/><circle cx="31" cy="31" r="6" fill="#26214c"/><circle cx="31" cy="30" r="5" fill="#181333"/></svg>;
}

function AgentConnection({agentName,reduce}:{agentName:string;reduce:boolean}){
 const repeat=reduce?0:Infinity;
 return <div className="agent-connection" role="status" aria-label={`Connecting to ${agentName}`}>
  <div className="agent-connection-visual" aria-hidden="true">
   <motion.span className="agent-connection-node" initial={reduce?false:{opacity:0,scale:.9,y:5}} animate={{opacity:1,scale:1,y:0}} transition={{duration:reduce?0:.32,ease:[.23,1,.32,1]}}><HermesConnectionMark/></motion.span>
   <span className="agent-connection-rail">
    <motion.span className="agent-connection-line" initial={reduce?false:{scaleX:0}} animate={{scaleX:1}} transition={{duration:reduce?0:.55,delay:reduce?0:.18,ease:[.23,1,.32,1]}}/>
    {!reduce&&<motion.span className="agent-connection-signal" initial={{left:'0%',opacity:0}} animate={{left:['0%','50%','100%'],opacity:[0,1,0],scale:[.7,1.15,.7]}} transition={{duration:1.55,delay:.55,repeat,ease:'easeInOut',repeatDelay:.28}}/>}
   </span>
   <motion.span className="agent-connection-node agent-connection-node-iris" initial={reduce?false:{opacity:0,scale:.86,y:5}} animate={{opacity:1,scale:1,y:0}} transition={{duration:reduce?0:.36,delay:reduce?0:.28,ease:[.23,1,.32,1]}}>
    <span className="agent-connection-orbit"/>
    <motion.span className="agent-connection-iris-glyph" animate={reduce?{scale:1}:{scale:[1,1.045,1]}} transition={{duration:2.4,delay:.7,ease:'easeInOut',repeat,repeatDelay:.15}}><IrisConnectionMark/></motion.span>
   </motion.span>
  </div>
  <div className="agent-connection-status"><motion.span className="agent-connection-dot" animate={reduce?{opacity:1}:{opacity:[.45,1,.45]}} transition={{duration:1.4,repeat,ease:'easeInOut'}}/><span>Connecting to {agentName}</span></div>
 </div>;
}
export function PartnerWorkspacePreview(){
 return <div className="agent-preview"><div className="agent-preview-head"><span>Hermes</span><span style={{marginLeft:'auto',color:'var(--ink-2)'}}>Partner program</span></div><div className="agent-preview-grid"><div className="agent-preview-nav"><span>Agents</span><span style={{color:'var(--ink)'}}>Inbox　4</span><span>Members</span><span>Shared skills</span><span>Settings</span></div><div className="agent-preview-content"><h3>Needs your review</h3>{[['Owen','Partner application','Review'],['Leah','Partner application','Review'],['Robin Studio','Services agreement','Sign'],['Robin Studio','Invoice · $1,200','Pay']].map(([name,desc,action])=><div key={name+desc} className="agent-preview-row"><span style={{fontSize:18,color:'var(--ink-2)'}}>◇</span><div>{name}<small>{desc}</small></div><span className="agent-preview-count">{action}</span></div>)}</div></div></div>;
}
export type AgentScreenProps={agentName?:string;streamSrc?:string;variant?:string;children?:ReactNode;onCaptureStart?:()=>void;onCaptureEnd?:(seconds:number)=>void;onOpenChange?:(open:boolean)=>void;};
/** Screen interaction is local unless supplied a stream and capture callbacks. No browser/microphone permission requested. */
export default function AgentScreen({agentName='Iris',streamSrc,variant='Working',children,onCaptureStart,onCaptureEnd,onOpenChange}:AgentScreenProps={}){
 const reduce=useReducedMotion();const loading=variant==='Loading';const[open,setOpen]=useState(false);const[recording,setRecording]=useState(false);const[secs,setSecs]=useState(0);const[saved,setSaved]=useState(false);
 const opener=useRef<HTMLButtonElement>(null);const dialog=useRef<HTMLDivElement>(null);const close=()=>{setOpen(false);onOpenChange?.(false);};
 useEffect(()=>{if(!recording)return;const start=Date.now();const timer=setInterval(()=>setSecs(Math.floor((Date.now()-start)/1000)),250);return()=>clearInterval(timer)},[recording]);
 useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.focus();
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close();}if(e.key==='Tab'){const els=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,[tabindex="0"]')||[]);if(!els.length){e.preventDefault();return;}const first=els[0],last=els[els.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last.focus()}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first.focus()}}};
  document.addEventListener('keydown',key);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',key);(previous||opener.current)?.focus()};
 },[open]);
 const capture=()=>{if(recording){setRecording(false);setSaved(true);onCaptureEnd?.(secs);}else{setSaved(false);setSecs(0);setRecording(true);onCaptureStart?.();}};
 const preview=streamSrc?(/\.(mp4|webm)(\?|$)/i.test(streamSrc)?<video src={streamSrc} autoPlay={!reduce} muted loop={!reduce} controls={reduce} playsInline style={{width:'100%',maxHeight:'70vh',objectFit:'contain'}}/>:<img src={streamSrc} alt={`${agentName}'s workspace`} style={{width:'100%',maxHeight:'70vh',objectFit:'contain'}}/>):(children||<PartnerWorkspacePreview/>);
 return <div className="w-full max-w-[680px]"><motion.div initial={reduce?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.38,ease:[.23,1,.32,1]}}>{loading?<div className="agent-preview agent-preview-loading"><AgentConnection agentName={agentName} reduce={reduce}/></div>:<button ref={opener} type="button" aria-label={`Open ${agentName}'s screen`} className="agent-window-open" onClick={()=>{setOpen(true);onOpenChange?.(true)}}>{preview}<span className="open-label">Open screen ↗</span></button>}</motion.div><div className="mt-4 flex items-center gap-3 text-sm"><span>{agentName}’s workspace</span>{recording?<span className="ml-auto text-red" role="status">● Demo capture · {secs}s</span>:<span className="ml-auto text-ink-3">{saved?'Example captured locally':'Preview'}</span>}</div>
 {typeof document!=='undefined'&&createPortal(<AnimatePresence>{open&&<motion.div key="viewer" className="hermes-ui fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6" data-reduced-motion={reduce} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:reduce?0:.18}}><div className="absolute inset-0 bg-black/70" onClick={close}/><motion.div ref={dialog} role="dialog" aria-modal="true" aria-label={`${agentName}'s screen`} tabIndex={-1} initial={reduce?false:{scale:.95}} animate={{scale:1}} exit={{scale:reduce?1:.97}} transition={{duration:reduce?0:.24,ease:[.23,1,.32,1]}} className="relative w-full max-w-[960px] overflow-hidden rounded-[16px] bg-surface p-3 shadow-overlay"><div className="flex items-center gap-3 pb-3"><strong className="font-medium">{agentName}</strong>{recording&&<span className="text-sm text-red">● Demo capture · {secs}s</span>}<div className="ml-auto flex items-center gap-2"><Button onClick={capture} size="sm">{recording?'End capture':'Teach a loop'}</Button><Button aria-label="Close screen" onClick={close} size="sm">✕</Button></div></div><div style={{maxHeight:'72vh',overflow:'auto'}}>{preview}</div><p className="pt-3 text-sm text-ink-2">{recording?'Demonstrate the steps. Capture is simulated in this showcase.':saved?'Captured example is ready to attach to a skill.':'Read-only preview · no actions run'}</p></motion.div></motion.div>}</AnimatePresence>,document.body)}
 </div>;
}
