'use client';

export default function ContentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main><h1>Contenu momentanément indisponible</h1>
    <p>Le contenu n’a pas pu être chargé. Vous pouvez réessayer dans quelques instants.</p>
    <button type="button" onClick={reset}>Réessayer</button></main>;
}
