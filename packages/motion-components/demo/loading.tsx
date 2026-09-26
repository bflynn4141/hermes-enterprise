import {useState} from 'react';
import LoadingState from '../src/components/primitives/LoadingState';
import AgentScreen from '../src/components/primitives/AgentScreen';
export function LoadingDemo(){const[variant,setVariant]=useState('Drive');const[active,setActive]=useState(true);return <div className="demo-stack"><div className="demo-center"><LoadingState key={variant} variant={variant} active={active}/></div><div className="demo-variants">{['Drive','Dots','Orbit','Context'].map(x=><button key={x} aria-pressed={x===variant} onClick={()=>setVariant(x)}>{x}</button>)}<button aria-pressed={!active} onClick={()=>setActive(x=>!x)}>{active?'Pause':'Resume'}</button></div></div>}
export function ScreenDemo(){const[v,set]=useState('Working');return <div className="demo-stack"><div className="demo-center"><AgentScreen variant={v}/></div><div className="demo-variants">{['Working','Loading'].map(x=><button key={x} aria-pressed={v===x} onClick={()=>set(x)}>{x}</button>)}</div></div>}
