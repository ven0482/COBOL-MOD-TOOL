export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
  createdAt: string;
  profile: {
    bio: string;
    avatarUrl: string;
    preferences: {
      theme: 'light' | 'dark';
      notifications: boolean;
    };
  };
}
