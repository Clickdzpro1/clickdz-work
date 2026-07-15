import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
  gap: 12,
  width: '100%',
  paddingTop: 4,
});

export const card = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 8,
  borderRadius: 10,
  cursor: 'pointer',
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
  background: cssVarV2('layer/background/secondary'),
  transition: 'border-color .15s, box-shadow .15s, transform .15s',
  selectors: {
    '&:hover': {
      borderColor: cssVarV2('layer/insideBorder/primaryBorder'),
      transform: 'translateY(-1px)',
    },
    '&[data-selected="true"]': {
      borderColor: cssVar('primaryColor'),
      boxShadow: `0 0 0 1px ${cssVar('primaryColor')}`,
    },
  },
});

export const preview = style({
  position: 'relative',
  height: 60,
  borderRadius: 6,
  overflow: 'hidden',
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
});

// mini "sidebar" strip on the left of the preview
export const previewSidebar = style({
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
  width: '38%',
  borderRight: '1px solid rgba(127,127,127,0.16)',
});

export const previewDot = style({
  position: 'absolute',
  top: 8,
  left: 8,
  width: 12,
  height: 12,
  borderRadius: '50%',
});

// two faux "rows" hinting at content
export const previewRow = style({
  position: 'absolute',
  height: 4,
  borderRadius: 2,
  opacity: 0.65,
});

export const label = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  fontSize: cssVar('fontXs'),
  fontWeight: 600,
  lineHeight: '16px',
  color: cssVarV2('text/primary'),
});

export const baseTag = style({
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '1px 5px',
  borderRadius: 4,
  color: cssVarV2('text/secondary'),
  background: cssVarV2('layer/background/tertiary'),
});

export const checkBadge = style({
  position: 'absolute',
  top: 6,
  right: 6,
  width: 16,
  height: 16,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: cssVar('pureWhite'),
  background: cssVar('primaryColor'),
  fontSize: 11,
  lineHeight: 1,
});
