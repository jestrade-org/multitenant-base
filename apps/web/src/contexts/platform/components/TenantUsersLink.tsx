import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useSession } from '../../../shared/auth/SessionProvider.js';

import './TenantUsersLink.css';

/**
 * A client's name, as the way into its people (§8.1, VC-101).
 *
 * Shared by every screen that lists companies — the roster and the quota table — because
 * two copies of the same affordance drift: one gets the permission check and the other
 * keeps sending operators to a screen that refuses them.
 *
 * Which is the second thing this settles. Opening a client's user list needs
 * `platform:support_access`, and an operator can hold `platform:plan_manage` without it —
 * repricing what a client is sold is not the same power as reading their books as one of
 * their own people. For those operators the name is plain text rather than a link to a
 * page that would answer 401. Hiding the link is UX, not security: the API refuses them
 * either way, and offering a door that does not open is how an interface teaches people it
 * cannot be trusted about what they can do.
 */
export function TenantUsersLink({
  tenantId,
  name,
  className,
}: {
  readonly tenantId: string;
  readonly name: string;
  /** Layout from the table it sits in; the link's own look comes from `tenant-link`. */
  readonly className?: string;
}) {
  const { t } = useTranslation('platform');
  const { can } = useSession();

  if (!can('platform:support_access')) {
    return <span className={className}>{name}</span>;
  }

  return (
    <Link
      className={`tenant-link${className === undefined ? '' : ` ${className}`}`}
      // The name alone is the visible label, which is right: in a column of companies,
      // "Acme Logistics Inc." is what an operator is looking for. The title says
      // where it goes, for anyone who needs to know before clicking.
      title={t('support.openUsers', { tenant: name })}
      to={`/plataforma/empresas/${tenantId}/usuarios`}
    >
      {name}
    </Link>
  );
}
