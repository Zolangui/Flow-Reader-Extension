import { useCallback, useEffect, useRef } from 'react'
import { useRecoilState } from 'recoil'

import { audioState } from '../state'

// This code is adapted from the article at https://noisehack.com/generate-noise-web-audio-api/

const createPinkNoiseNode = (audioContext: AudioContext) => {
  const bufferSize = 4096
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  const node = audioContext.createScriptProcessor(bufferSize, 1, 1)

  node.onaudioprocess = (e) => {
    const output = e.outputBuffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.96900 * b2 + white * 0.1538520
      b3 = 0.86650 * b3 + white * 0.3104856
      b4 = 0.55000 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.016898
      output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362
      output[i] *= 0.11 // compensate for gain
      b6 = white * 0.115926
    }
  }
  return node
}

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState)
  const audioContextRef = useRef<AudioContext | null>(null)
  const pinkNoiseNodeRef = useRef<ScriptProcessorNode | null>(null)

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    return audioContextRef.current
  }, [])

  const getPinkNoiseNode = useCallback(() => {
    const audioContext = getAudioContext()
    if (!pinkNoiseNodeRef.current) {
      pinkNoiseNodeRef.current = createPinkNoiseNode(audioContext)
    }
    return pinkNoiseNodeRef.current
  }, [getAudioContext])

  useEffect(() => {
    const node = getPinkNoiseNode()
    if (audio.isPlaying) {
      node.connect(getAudioContext().destination)
    } else {
      node.disconnect()
    }
  }, [audio.isPlaying, getAudioContext, getPinkNoiseNode])

  const play = () => setAudio((prev) => ({ ...prev, isPlaying: true }))
  const pause = () => setAudio((prev) => ({ ...prev, isPlaying: false }))
  const toggle = () => setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }))

  return { isPlaying: audio.isPlaying, play, pause, toggle }
}
