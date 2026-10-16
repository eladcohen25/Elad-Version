import { markOnce } from './timeline'

/** Load progress of the material library, observable without importing three.js. */
type Listener = () => void
const listeners = new Set<Listener>()
let snapshot = { requested: 0, loaded: 0 }

export const textureProgress = {
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: () => snapshot,
  /** Called by the material library as maps are requested and arrive. */
  update(requested: number, loaded: number) {
    snapshot = { requested: snapshot.requested + requested, loaded: snapshot.loaded + loaded }
    if (snapshot.requested > 0)
      for (const pct of [25, 50, 75, 100])
        if (snapshot.loaded * 100 >= snapshot.requested * pct)
          markOnce(`textures-${pct}%`, { loaded: snapshot.loaded, requested: snapshot.requested })
    listeners.forEach((listener) => listener())
  },
}
