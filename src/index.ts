import 'reflect-metadata';
import { Application } from '@/app/application.js';
import { ApplicationRunner } from '@/app/application-runner.js';
import { AppContainer } from '@/core/container/app.container.js';

const container = new AppContainer();
const application = new Application(container);
const runner = new ApplicationRunner(container, application);

runner.registerSignalHandlers();
await runner.start();
