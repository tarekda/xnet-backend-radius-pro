import helmet from 'helmet';
import cors from 'cors';

export const securityMiddleware = (app: any) => {
    app.use(helmet());
    app.use(cors({
        origin: '*',
    }));
};
