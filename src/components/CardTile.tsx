import React from 'react';
import type { PtvItem } from '../types/ptv';
import { FocusableButton } from './FocusableButton';

export function CardTile({
  item,
  focusId,
  onOpen,
  posterUrl,
  preferredRow,
  onFocus
}: {
  item: PtvItem;
  focusId: string;
  onOpen: () => void;
  posterUrl?: string | null;
  preferredRow?: string;
  onFocus?: () => void;
}) {
  return (
    <li className="ptv-card">
      <FocusableButton
        focusId={focusId}
        preferredRow={preferredRow}
        onClick={onOpen}
        onFocus={onFocus}
        className="ptv-card-btn"
        aria-label={item.name}
      >
        {posterUrl ? <img src={posterUrl} alt="" /> : <div className="ptv-card-placeholder" aria-hidden="true" />}
        <div className="ptv-card-title">{item.name}</div>
      </FocusableButton>
    </li>
  );
}
