import { splitBareUrls } from '../../../core/markdown-lite'

/** Renders plain text with bare http(s) URLs as clickable links. The main
 *  process routes target=_blank opens to the system browser. */
export function Linkified({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {splitBareUrls(text).map((seg, i) =>
        seg.url ? (
          <a
            key={i}
            href={seg.text}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2 break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}
