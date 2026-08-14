import { ToolkitApp } from '../shell/App.js';

export function mountToolkitApp(target, props) {
  return new ToolkitApp(target, props).mount();
}
