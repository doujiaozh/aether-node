/**
 * micro-vm — sandboxed execution of AI-generated code.
 *
 * {@link MicroVm} is the only entry point: submit code plus a plain-data
 * context, receive a {@link VmResult} envelope that never throws.
 */

export {
  MicroVm,
  clonePlainContext,
  normalizeVmOptions,
  type VmExecutionOptions,
  type VmResult,
  type VmStatus,
  type VmErrorInfo,
  type NormalizedVmOptions,
} from './vm.js';
