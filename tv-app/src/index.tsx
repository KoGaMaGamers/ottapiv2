/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { installHardwareBackHandler } from './lib/hardwareBack'

// Install BEFORE render so the capture-phase keydown listener is in
// place when any user gesture arrives. See lib/hardwareBack.ts for
// rationale.
installHardwareBackHandler()

const root = document.getElementById('root')

render(() => <App />, root!)
