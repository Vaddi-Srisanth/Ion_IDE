/// <reference types="vite/client" />

import type { IonBridge } from '../shared/contracts';

declare global {
  interface Window {
    ion: IonBridge;
  }
}
