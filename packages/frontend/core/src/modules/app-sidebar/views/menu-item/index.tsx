import { WorkbenchLink } from '@affine/core/modules/workbench';
import { ArrowDownSmallIcon } from '@blocksuite/icons/rc';
import clsx from 'clsx';
import React, { type SVGAttributes } from 'react';
import type { To } from 'react-router-dom';

import * as styles from './index.css';

export interface MenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactElement<SVGAttributes<SVGElement>>;
  active?: boolean;
  disabled?: boolean;
  // true, false, undefined. undefined means no collapse
  collapsed?: boolean;
  // if onCollapsedChange is given, but collapsed is undefined, then we will render the collapse button as disabled
  onCollapsedChange?: (collapsed: boolean) => void;
  postfix?: React.ReactElement;
  postfixDisplay?: 'always' | 'hover';
}

export interface MenuLinkItemProps extends MenuItemProps {
  to: To;
  linkComponent?: React.ComponentType<{ to: To; className?: string }>;
}

const stopPropagation: React.MouseEventHandler = e => {
  e.stopPropagation();
};

/**
 * This component is not a generic component.
 * It is used for the app sidebar.
 */
export const MenuItem = React.forwardRef<HTMLDivElement, MenuItemProps>(
  (
    {
      onClick,
      icon,
      active,
      children,
      disabled,
      collapsed,
      onCollapsedChange,
      postfix,
      postfixDisplay = 'hover',
      ...props
    },
    ref
  ) => {
    const collapsible = onCollapsedChange !== undefined;
    return (
      <div
        ref={ref}
        {...props}
        onClick={onClick}
        className={clsx([styles.root, props.className])}
        data-active={active}
        data-disabled={disabled}
        data-collapsible={collapsible}
        // Default `0` (standalone MenuItem is its own focus target). When wrapped
        // by MenuLinkItem the focusable <a> is the tab stop, so it passes
        // `tabIndex={-1}` here to avoid a second, duplicate tab stop on the same
        // row (the wrapper's :focus-visible still surfaces the ring on this row).
        tabIndex={props.tabIndex ?? 0}
      >
        {icon && (
          <div className={styles.iconsContainer} data-collapsible={collapsible}>
            {collapsible && (
              <div
                data-disabled={collapsed === undefined ? true : undefined}
                onClick={e => {
                  e.stopPropagation();
                  e.preventDefault(); // for links
                  onCollapsedChange?.(!collapsed);
                }}
                data-testid="fav-collapsed-button"
                className={styles.collapsedIconContainer}
              >
                <ArrowDownSmallIcon
                  className={styles.collapsedIcon}
                  data-collapsed={collapsed !== false}
                />
              </div>
            )}
            {React.cloneElement(icon, {
              className: clsx([styles.icon, icon.props.className]),
            })}
          </div>
        )}

        <div className={styles.content}>{children}</div>
        {postfix ? (
          <div
            className={styles.postfix}
            data-postfix-display={postfixDisplay}
            onClick={stopPropagation}
          >
            {postfix}
          </div>
        ) : null}
      </div>
    );
  }
);
MenuItem.displayName = 'MenuItem';

export const MenuLinkItem = React.forwardRef<HTMLDivElement, MenuLinkItemProps>(
  ({ to, linkComponent: LinkComponent = WorkbenchLink, ...props }, ref) => {
    return (
      <LinkComponent to={to} className={styles.linkItemRoot}>
        {/* linkItemRoot is `display: contents`, so the <a> generates no box and
            never paints its own ring; it stays keyboard-focusable as the link.
            Thus ref is passed to MenuItem instead of Link. */}
        {/* tabIndex={-1}: the focusable <a> is the single tab stop for this row —
            without this the inner row would be a second, duplicate tab stop. The
            <a>'s :focus-visible still surfaces the one focus ring on the row. */}
        <MenuItem ref={ref} tabIndex={-1} {...props}></MenuItem>
      </LinkComponent>
    );
  }
);
MenuLinkItem.displayName = 'MenuLinkItem';
