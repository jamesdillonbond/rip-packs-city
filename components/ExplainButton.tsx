'use client'

import React from 'react'

type Props = {
  /** Plain-language description of the element being explained. */
  context: string
  /** Question template (e.g. "How is this FMV calculated?"). */
  question: string
  /** Optional sizing override. */
  size?: number
}

/**
 * Small "?" button that opens the SupportChat concierge with a pre-filled
 * question. Dispatches a `rpc-concierge-ask` CustomEvent the chat listens for.
 */
export default function ExplainButton({ context, question, size = 14 }: Props) {
  function ask(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (typeof window === 'undefined') return
    const text = `${question}\n\nContext: ${context}`
    window.dispatchEvent(new CustomEvent('rpc-concierge-ask', { detail: { text } }))
  }

  return (
    <button
      type="button"
      onClick={ask}
      title={question}
      aria-label={`Explain: ${question}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.25)',
        background: 'transparent',
        color: 'rgba(255,255,255,0.7)',
        fontSize: Math.max(8, size - 5),
        fontFamily: "'Share Tech Mono', monospace",
        fontWeight: 700,
        cursor: 'pointer',
        opacity: 0.4,
        padding: 0,
        lineHeight: 1,
        transition: 'opacity 120ms',
        verticalAlign: 'middle',
        marginLeft: 4,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.85' }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.4' }}
    >
      ?
    </button>
  )
}
