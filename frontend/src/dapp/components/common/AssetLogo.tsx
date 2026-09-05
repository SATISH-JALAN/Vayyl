'use client';

import { useState } from 'react';

import { assetIconUrl, monogram, monogramHue, type AssetRef } from '../../lib/assets';

/**
 * An asset's logo, resolved automatically.
 *
 * Nothing here knows about any particular asset. The src points at
 * /api/asset-icon, which walks SEP-1 -- issuer account, home domain,
 * stellar.toml, the [[CURRENCIES]] entry matching this exact code AND issuer --
 * so listing a new asset requires no change to this component and no new file
 * in public/.
 *
 * When an asset publishes no logo the route answers 404 and this falls back to
 * a monogram in a colour derived from the code. It deliberately does NOT fall
 * back to a similar asset's mark: anyone can issue a token called USDC, and
 * showing Circle's logo on someone else's is the one mistake that would matter.
 */
export default function AssetLogo({
  asset,
  size = 30,
  className = '',
}: {
  asset: AssetRef;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const label = monogram(asset.code);

  if (failed) {
    return (
      <span
        className={`vy-asset vy-asset--mono ${className}`.trim()}
        style={{
          width: size,
          height: size,
          // A stable hue per code, so an asset looks like itself between
          // sessions without a colour being assigned anywhere.
          background: `hsl(${monogramHue(asset.code)} 42% 22%)`,
          color: `hsl(${monogramHue(asset.code)} 70% 76%)`,
          fontSize: Math.max(8, size * (label.length > 3 ? 0.26 : 0.32)),
        }}
        title={asset.code}
        aria-label={asset.code}
      >
        {label}
      </span>
    );
  }

  return (
    <span className={`vy-asset ${className}`.trim()} style={{ width: size, height: size }}>
      <img
        src={assetIconUrl(asset)}
        alt={asset.code}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
