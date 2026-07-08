import { LandingClient } from './landing-client';
import { landingMarkup } from './landing-markup';

export default function LandingPage() {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: landingMarkup }} />
      <LandingClient />
    </>
  );
}
