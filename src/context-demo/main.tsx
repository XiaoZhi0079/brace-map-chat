import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ContextDemo from './ContextDemo.tsx'
import './context-demo.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ContextDemo />
  </StrictMode>,
)
