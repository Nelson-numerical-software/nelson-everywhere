// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// SharedWorker entry point: the origin-wide relay between the page that owns
// the Nelson engine Worker and the other pages (desktop, NFlow editor,
// satellite windows) that share its workspace. See nelson-engine-broker.mjs.
import { createEngineBroker } from "./nelson-engine-broker.mjs?build=66ef9d93d96c";

const broker = createEngineBroker();

self.addEventListener("connect", (event) => {
  for (const port of event.ports) broker.connect(port);
});
