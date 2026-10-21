import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmployeeDto } from '../../shared/types.js';
import { api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Dialog } from './ui';

// Selfie capture with getUserMedia only. There is intentionally no file input
// and no gallery fallback. A web page can offer a camera-only interface, but it
// cannot prove where an image came from: the server treats every upload as
// untrusted and re-encodes it.

type CameraError = 'insecure' | 'unsupported' | 'denied' | 'notFound' | 'busy' | 'other';
type Phase = 'consent' | 'starting' | 'live' | 'review' | 'saving' | 'error';

const CAPTURE_SIZE = 720;

function classify(err: unknown): CameraError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'notFound';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'other';
}

export function SelfieDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (e: EmployeeDto) => void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('consent');
  const [error, setError] = useState<CameraError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);

  const discardShot = useCallback(() => {
    setShot((s) => {
      if (s) URL.revokeObjectURL(s.url);
      return null;
    });
  }, []);

  // Reset when the dialog opens/closes; always switch the camera off on close.
  useEffect(() => {
    if (open) {
      setPhase('consent');
      setError(null);
      setSaveError(null);
    } else {
      stop();
      discardShot();
    }
    return stop;
  }, [open, stop, discardShot]);

  const start = useCallback(async () => {
    setError(null);
    setSaveError(null);
    if (!window.isSecureContext) {
      setError('insecure');
      setPhase('error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('unsupported');
      setPhase('error');
      return;
    }
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      streamRef.current = stream;
      setPhase('live');
    } catch (err) {
      setError(classify(err));
      setPhase('error');
    }
  }, []);

  // Attach the stream once the <video> element is rendered.
  useEffect(() => {
    const v = videoRef.current;
    if (phase === 'live' && v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => undefined);
    }
  }, [phase]);

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    // Same square as the preview shows (object-fit: cover crops the centre).
    const side = Math.min(v.videoWidth, v.videoHeight);
    const sx = (v.videoWidth - side) / 2;
    const sy = (v.videoHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = CAPTURE_SIZE;
    canvas.height = CAPTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, sx, sy, side, side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
    // A canvas export carries no EXIF/GPS metadata; the server re-encodes anyway.
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        stop(); // the camera is off while the person looks at the result
        setShot({ blob, url: URL.createObjectURL(blob) });
        setPhase('review');
      },
      'image/jpeg',
      0.9,
    );
  };

  const retake = () => {
    discardShot();
    void start();
  };

  const save = async () => {
    if (!shot) return;
    setPhase('saving');
    setSaveError(null);
    try {
      const employee = await api<EmployeeDto>('PUT', '/api/me/photo', undefined, { blob: shot.blob });
      discardShot();
      onSaved(employee);
    } catch (err) {
      setSaveError(errorText(t, err));
      setPhase('review');
    }
  };

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  return (
    <Dialog open={open} onClose={onClose} title={phase === 'consent' ? t('camera.consentTitle') : t('camera.title')}>
      {phase === 'consent' && (
        <div className="camera-consent">
          <p>{t('camera.consent1')}</p>
          <p>{t('camera.consent2')}</p>
          <p className="muted">{t('camera.consent3')}</p>
          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void start()}>
              {t('camera.enable')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {(phase === 'starting' || phase === 'live') && (
        <div className="camera">
          <div className="camera__view">
            <video ref={videoRef} className="camera__video" playsInline muted autoPlay aria-label={t('camera.frameHint')} />
            <svg className="camera__frame" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <mask id="face-hole">
                  <rect width="100" height="100" fill="white" />
                  <ellipse cx="50" cy="46" rx="27" ry="35" fill="black" />
                </mask>
              </defs>
              <rect width="100" height="100" fill="rgba(12,26,38,0.45)" mask="url(#face-hole)" />
              <ellipse cx="50" cy="46" rx="27" ry="35" fill="none" stroke="white" strokeWidth="0.8" strokeDasharray="2 1.6" />
            </svg>
            {phase === 'starting' && <p className="camera__status">{t('camera.starting')}</p>}
          </div>
          <p className="camera__hint">{t('camera.frameHint')}</p>
          <div className="actions actions--center">
            <button type="button" className="btn btn--primary btn--shutter" onClick={capture} disabled={phase !== 'live'}>
              {t('camera.capture')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {(phase === 'review' || phase === 'saving') && shot && (
        <div className="camera">
          <div className="camera__view">
            <img className="camera__result" src={shot.url} alt={t('camera.review')} />
          </div>
          <p className="camera__hint">{t('camera.review')}</p>
          {saveError && (
            <p className="form-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="actions actions--center">
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={phase === 'saving'}>
              {phase === 'saving' ? t('common.saving') : t('camera.save')}
            </button>
            <button type="button" className="btn btn--secondary" onClick={retake} disabled={phase === 'saving'}>
              {t('camera.retake')}
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && error && (
        <div className="camera-error" role="alert">
          <p className="state__title">{t('camera.errorTitle')}</p>
          {error === 'denied' ? (
            <>
              <p>{t('camera.denied')}</p>
              <p>{isIos ? t('camera.deniedIos') : t('camera.deniedAndroid')}</p>
              <p className="muted">{isIos ? t('camera.deniedAndroid') : t('camera.deniedIos')}</p>
              <p>{t('camera.deniedThen')}</p>
            </>
          ) : (
            <p>{t(`camera.${error}`)}</p>
          )}
          <p className="muted">{t('camera.noGallery')}</p>
          <div className="actions">
            {error !== 'insecure' && error !== 'unsupported' && (
              <button type="button" className="btn btn--primary" onClick={() => void start()}>
                {t('common.retry')}
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
