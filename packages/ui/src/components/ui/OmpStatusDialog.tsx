import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

export const OmpStatusDialog: React.FC = () => {
  const { t } = useI18n();
  const isOmpStatusDialogOpen = useUIStore((state) => state.isOmpStatusDialogOpen);
  const setOmpStatusDialogOpen = useUIStore((state) => state.setOmpStatusDialogOpen);
  const ompStatusText = useUIStore((state) => state.ompStatusText);

  const handleCopy = React.useCallback(async () => {
    if (!ompStatusText) {
      return;
    }

    const result = await copyTextToClipboard(ompStatusText);
    if (result.ok) {
      toast.success(t('ompStatusDialog.toast.copiedTitle'), { description: t('ompStatusDialog.toast.copiedDescription') });
      return;
    }
    toast.error(t('ompStatusDialog.toast.copyFailed'));
  }, [ompStatusText, t]);

  return (
    <Dialog open={isOmpStatusDialogOpen} onOpenChange={setOmpStatusDialogOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('ompStatusDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('ompStatusDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className="app-region-no-drag inline-flex h-9 items-center justify-center rounded-md px-3 typography-ui-label font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {t('ompStatusDialog.actions.copy')}
          </button>
        </div>

        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-muted p-4 typography-code text-foreground whitespace-pre-wrap">
          {ompStatusText || t('ompStatusDialog.empty.noData')}
        </pre>
      </DialogContent>
    </Dialog>
  );
};
