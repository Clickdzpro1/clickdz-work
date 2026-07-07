import { useI18n } from '@affine/i18n';

import { SettingGroup } from '../group';
import { RowLayout } from '../row.layout';
import { DeleteAccount } from './delete-account';
import { hotTag } from './index.css';

export const OthersGroup = () => {
  const t = useI18n();

  return (
    <SettingGroup title={t['com.affine.mobile.setting.others.title']()}>
      <RowLayout
        label={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {t['com.affine.mobile.setting.others.discord']()}
            <div className={hotTag}>Hot</div>
          </div>
        }
        href="https://clickdz.ai"
      />
      <RowLayout
        label={t['com.affine.mobile.setting.others.github']()}
        href="https://github.com/Clickdzpro1/clickdz-work"
      />

      <RowLayout
        label={t['com.affine.mobile.setting.others.website']()}
        href="https://clickdz.ai"
      />

      <RowLayout
        label={t['com.affine.mobile.setting.others.privacy']()}
        href="https://clickdz.ai"
      />

      <RowLayout
        label={t['com.affine.mobile.setting.others.terms']()}
        href="https://clickdz.ai"
      />
      <DeleteAccount />
    </SettingGroup>
  );
};
