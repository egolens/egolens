import './adapterEntry.css'

export default function AgentSetupCard({ title = 'Setup for AI teaching', onCheckAgain, status }: { title?: string; onCheckAgain?: () => void; status?: string }) {
  return (
    <section className="adapter-intro-environment" aria-label={title}>
      <h3>{title}</h3>
      <p><strong><a href="https://openai.com/codex/" target="_blank" rel="noopener noreferrer">Codex desktop app ↗</a> · Recommended</strong><br />
        Open EgoLens in the app’s in-app browser. Recommended models: GPT-5.6 Terra or Sol.</p>
      <details>
        <summary>Alternative: Chrome 149+ with WebMCP enabled</summary>
        <p>In Chrome 149 or later, open <code>chrome://flags/#enable-webmcp-testing</code>, set the flag to <strong>Enabled</strong>, then restart Chrome.</p>
        <p>To create a recipe, use an AI agent that can access this page’s WebMCP tools.</p>
        <a href="https://developer.chrome.com/docs/ai/webmcp#local-webmcp" target="_blank" rel="noopener noreferrer">Chrome WebMCP setup guide ↗</a>
      </details>
      {onCheckAgain && <button type="button" className="adapter-intro-cta" onClick={onCheckAgain}>Check again</button>}
      {status && <p role="status">{status}</p>}
    </section>
  )
}
