import jwt from 'jsonwebtoken';

export function authenticate(req, res, next) {
  const token =
    req.cookies?.mim_token || req.headers?.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, message: 'Non authentifié.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Session expirée.' });
  }
}

export function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}
