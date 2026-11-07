import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { formatDateTime, PLATFORM_TIMEZONE } from '../../../shared/i18n/format.js';
import {
  HttpPlatformOperationsClient,
  type DeadLetterJob,
  type QueueSnapshot,
} from '../api/operationsClient.js';
import { PlatformError } from '../api/platformClient.js';

import './QueuesPage.css';

/**
 * Queue and job monitoring, including the dead-letter queue (§7, §14, VC-75).
 *
 * The screen exists to end a silence. A job that exhausts its retries stops, nothing
 * errors, and the only symptom is a client who never got the reminder that was drafted for
 * them. So the dead-letter count is the first number on every row, not a detail behind a
 * tab.
 *
 * What a failed job shows is a class and a correlation id, never its payload or its error
 * message: a job's payload is a domain event about a company's data, and a Postgres
 * message quotes the row that failed. The panel is not an audited elevation (§8.1). The
 * correlation id is what joins to the log that does hold the detail.
 */

const client = new HttpPlatformOperationsClient();

const QUEUE_KEYS = {
  queues: ['platform', 'queues'] as const,
  deadLetter: (queue: string | undefined) => ['platform', 'queues', 'dead-letter', queue] as const,
};

/**
 * How often the screen refetches while it is open.
 *
 * Thirty seconds: an operator watching a backlog drain wants to see it move, and a queue
 * screen that needs a manual refresh is a queue screen nobody trusts. Cheap — it is two
 * grouped queries against a table pg-boss already indexes.
 */
const REFRESH_MS = 30_000;

export function QueuesPage() {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();
  const [queueFilter, setQueueFilter] = useState<string | undefined>(undefined);

  const queues = useQuery({
    queryKey: QUEUE_KEYS.queues,
    queryFn: ({ signal }) => client.listQueues(signal),
    refetchInterval: REFRESH_MS,
  });

  const deadLetter = useQuery({
    queryKey: QUEUE_KEYS.deadLetter(queueFilter),
    queryFn: ({ signal }) => client.listDeadLettered(queueFilter, signal),
    refetchInterval: REFRESH_MS,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: QUEUE_KEYS.queues });
    void queryClient.invalidateQueries({ queryKey: ['platform', 'queues', 'dead-letter'] });
  };

  if (queues.isPending) {
    return (
      <Card title={t('queues.title')}>
        <Skeleton rows={5} />
      </Card>
    );
  }

  if (queues.isError) {
    return (
      <ErrorState
        message={t('queues.error')}
        onRetry={() => void queues.refetch()}
        retryLabel={t('queues.retry')}
      />
    );
  }

  return (
    <div className="queues">
      <p className="queues__intro">{t('queues.intro')}</p>

      <Card title={t('queues.listTitle')}>
        <div className="queues__scroll">
          <table className="queues__table">
            <caption className="queues__caption">{t('queues.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('queues.columns.queue')}</th>
                <th scope="col">{t('queues.columns.pending')}</th>
                <th scope="col">{t('queues.columns.active')}</th>
                <th scope="col">{t('queues.columns.oldest')}</th>
                <th scope="col">{t('queues.columns.completed')}</th>
                <th scope="col">{t('queues.columns.failed')}</th>
                <th scope="col">{t('queues.columns.deadLettered')}</th>
              </tr>
            </thead>
            <tbody>
              {queues.data.map((queue) => (
                <QueueRow
                  key={queue.name}
                  onSelect={() => {
                    setQueueFilter(queue.name === queueFilter ? undefined : queue.name);
                  }}
                  queue={queue}
                  selected={queue.name === queueFilter}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('queues.deadLetter.title')}>
        <div className="queues__filter">
          <span>{t('queues.deadLetter.showing')}</span>
          <strong>
            {queueFilter === undefined
              ? t('queues.deadLetter.allQueues')
              : t(`queues.names.${queueFilter}`, { defaultValue: queueFilter })}
          </strong>
          {queueFilter === undefined ? null : (
            <button
              className="button button--secondary"
              onClick={() => {
                setQueueFilter(undefined);
              }}
              type="button"
            >
              {t('queues.deadLetter.clearFilter')}
            </button>
          )}
        </div>

        {deadLetter.isPending ? (
          <Skeleton rows={3} />
        ) : deadLetter.isError ? (
          <ErrorState
            message={t('queues.deadLetter.error')}
            onRetry={() => void deadLetter.refetch()}
            retryLabel={t('queues.retry')}
          />
        ) : deadLetter.data.length === 0 ? (
          <EmptyState message={t('queues.deadLetter.empty')} />
        ) : (
          <ul className="queues__jobs">
            {deadLetter.data.map((job) => (
              <DeadLetterRow job={job} key={job.jobId} onResolved={invalidate} />
            ))}
          </ul>
        )}

        <p className="queues__hint">{t('queues.deadLetter.privacyNote')}</p>
      </Card>
    </div>
  );
}

/**
 * The age at which a waiting job stops being normal.
 *
 * Fifteen minutes. Every queue in the catalogue is worked continuously, so a job that has
 * waited longer than a coffee break is waiting on something broken rather than on load.
 */
const STALE_AFTER_SECONDS = 900;

function QueueRow({
  queue,
  selected,
  onSelect,
}: {
  readonly queue: QueueSnapshot;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation('platform');
  const stale =
    queue.oldestPendingAgeSeconds !== undefined &&
    queue.oldestPendingAgeSeconds > STALE_AFTER_SECONDS;

  return (
    <tr className={selected ? 'queues__row--selected' : undefined}>
      <th scope="row">
        <span className="queues__name">
          {t(`queues.names.${queue.name}`, { defaultValue: queue.name })}
        </span>
        {/* The Spanish sentence, not the catalogue's `describes`. That field is English —
            it documents the queue for whoever reads the code — and rendering it here put
            English on a Spanish screen (language-i18n.md). The API field stays as it is;
            the screen translates the queue's name into copy a person reads. */}
        <span className="queues__describes">
          {t(`queues.descriptions.${queue.name}`, { defaultValue: '' })}
        </span>
      </th>
      <td className="queues__figure">{queue.pending}</td>
      <td className="queues__figure">{queue.active}</td>
      <td className={`queues__figure${stale ? ' queues__figure--stale' : ''}`}>
        {queue.oldestPendingAgeSeconds === undefined
          ? '—'
          : formatAge(t, queue.oldestPendingAgeSeconds)}
        {/* A word as well as the colour: a stalled queue must be readable in greyscale. */}
        {stale ? <span className="queues__flag">{t('queues.stalled')}</span> : null}
      </td>
      <td className="queues__figure">{queue.completedLastDay}</td>
      <td className="queues__figure">{queue.failedLastDay}</td>
      <td className="queues__figure">
        {queue.deadLettered === 0 ? (
          '0'
        ) : (
          <button className="queues__link" onClick={onSelect} type="button">
            {queue.deadLettered}
          </button>
        )}
      </td>
    </tr>
  );
}

function formatAge(t: ReturnType<typeof useTranslation<'platform'>>['t'], seconds: number): string {
  if (seconds < 60) return t('queues.age.seconds', { count: seconds });
  if (seconds < 3600) return t('queues.age.minutes', { count: Math.floor(seconds / 60) });
  return t('queues.age.hours', { count: Math.floor(seconds / 3600) });
}

function DeadLetterRow({
  job,
  onResolved,
}: {
  readonly job: DeadLetterJob;
  readonly onResolved: () => void;
}) {
  const { t } = useTranslation('platform');
  const reasonId = useId();
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('');

  const replay = useMutation({
    mutationFn: () => client.replayJob(job.jobId),
    onSuccess: onResolved,
  });

  const discard = useMutation({
    mutationFn: () => client.discardJob(job.jobId, reason.trim()),
    onSuccess: () => {
      setDiscarding(false);
      onResolved();
    },
  });

  const failure =
    replay.error instanceof PlatformError
      ? replay.error
      : discard.error instanceof PlatformError
        ? discard.error
        : undefined;

  return (
    <li className="queues__job">
      <div className="queues__job-head">
        <span className="queues__job-name">{job.jobName}</span>
        <span className="queues__job-queue">
          {t(`queues.names.${job.queue}`, { defaultValue: job.queue })}
        </span>
      </div>

      <dl className="queues__job-facts">
        <div>
          <dt>{t('queues.deadLetter.failedAt')}</dt>
          <dd>{formatDateTime(job.failedAt, PLATFORM_TIMEZONE)}</dd>
        </div>
        <div>
          <dt>{t('queues.deadLetter.attempts')}</dt>
          <dd>{job.attempts}</dd>
        </div>
        <div>
          <dt>{t('queues.deadLetter.failureClass')}</dt>
          <dd>
            <code>{job.failureClass}</code>
          </dd>
        </div>
        <div>
          <dt>{t('queues.deadLetter.correlationId')}</dt>
          <dd>
            <code>{job.correlationId ?? '—'}</code>
          </dd>
        </div>
      </dl>

      {failure === undefined ? null : (
        <p className="queues__error" role="alert">
          {t(`queues.deadLetter.errors.${failure.code}`, {
            defaultValue: t('queues.deadLetter.errors.default'),
          })}
        </p>
      )}

      {discarding ? (
        <div className="queues__discard">
          <label htmlFor={reasonId}>{t('queues.deadLetter.reasonLabel')}</label>
          <input
            id={reasonId}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            value={reason}
          />
          <p className="queues__hint">{t('queues.deadLetter.reasonHint')}</p>
          <div className="queues__job-actions">
            <button
              className="button"
              // The floor the server enforces, stated here too so the operator is refused
              // before the round trip rather than after it.
              disabled={reason.trim().length < 10 || discard.isPending}
              onClick={() => {
                discard.mutate();
              }}
              type="button"
            >
              {discard.isPending
                ? t('queues.deadLetter.discarding')
                : t('queues.deadLetter.confirmDiscard')}
            </button>
            <button
              className="button button--secondary"
              onClick={() => {
                setDiscarding(false);
              }}
              type="button"
            >
              {t('queues.deadLetter.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="queues__job-actions">
          <button
            className="button"
            disabled={replay.isPending}
            onClick={() => {
              replay.mutate();
            }}
            type="button"
          >
            {replay.isPending ? t('queues.deadLetter.replaying') : t('queues.deadLetter.replay')}
          </button>
          <button
            className="button button--secondary"
            onClick={() => {
              setDiscarding(true);
            }}
            type="button"
          >
            {t('queues.deadLetter.discard')}
          </button>
        </div>
      )}
    </li>
  );
}
