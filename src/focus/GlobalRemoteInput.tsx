import { useEffect, useMemo } from 'react';
import {
  GlobalRemoteInputController,
  type GlobalRemoteInputOptions
} from './remoteInput';

export type GlobalRemoteInputProps = GlobalRemoteInputOptions;

export function GlobalRemoteInput(props: GlobalRemoteInputProps) {
  const controller = useMemo(
    () => new GlobalRemoteInputController({
      focusManager: props.focusManager,
      target: props.target
    }),
    [props.focusManager, props.target]
  );

  useEffect(() => {
    controller.updateOptions(props);
  }, [controller, props]);

  useEffect(() => {
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);

  return null;
}
