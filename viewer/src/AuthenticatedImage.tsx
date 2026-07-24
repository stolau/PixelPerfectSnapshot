import { useEffect, useState } from "react";
import { authHeaders } from "./authToken.js";

type AuthenticatedImageProps = Omit<JSX.IntrinsicElements["img"], "src"> & { src: string };

/**
 * Like <img src=...>, but fetches src with the auth header and renders the response as an
 * object URL, since <img> itself has no way to attach headers to its request. Every prop except
 * src is forwarded to the underlying <img> untouched (onLoad, alt, etc. behave exactly as before).
 */
export function AuthenticatedImage({ src, ...imgProps }: AuthenticatedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setObjectUrl(null);
    setError(null);

    fetch(src, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? "Image failed to load — check your auth token above"
              : `Image failed to load (${res.status})`,
          );
        }
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [src]);

  if (error !== null) {
    return <p>{error}</p>;
  }

  return <img src={objectUrl ?? undefined} {...imgProps} />;
}
