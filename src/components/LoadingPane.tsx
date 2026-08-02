import React from 'react';

export function LoadingPane({ message }: { message: string }) {
  return (
    <div className="ptv-loading">
      <div className="ptv-loading__spinner" />
      <div>{message}</div>
    </div>
  );
}
