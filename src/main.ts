import { runViewer } from './viewer';

const params = new URLSearchParams(location.search);
if (params.has('viewer')) runViewer(params);
